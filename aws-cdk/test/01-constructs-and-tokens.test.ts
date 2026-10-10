import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import {
  addToApp,
  classify,
  describeIds,
  LevelsStack,
  namingBug,
  namingFix,
  ParametersStack,
  predictLogicalId,
  PrefixedIdsStack,
  TokensStack,
} from '../src/modules/01-constructs-and-tokens';
import { DefaultScopeStack } from '../src/modules/01-constructs-and-tokens/solutions/exercise-1-default-scope';
import { isWithin, requireLiteral, third, withSuffix } from '../src/modules/01-constructs-and-tokens/solutions/exercise-2-token-guards';
import { RefactoredStack } from '../src/modules/01-constructs-and-tokens/solutions/exercise-3-refactor-without-replacement';

describe('01 · L1 / L2 / L3 on the same resource', () => {
  // cdk.json enables this flag for the CLI; tests must opt in explicitly.
  const LOGS_VIA_POLICY = { '@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy': true };
  const app = new cdk.App({ context: LOGS_VIA_POLICY });
  const stack = new LevelsStack(app, 'M01-Levels', { tier: 'dev' });
  const template = Template.fromStack(stack);

  test('L1 renders exactly what was written, nothing more', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true },
    });
    // the L1 is its own CfnElement: no `Resource` child, id is verbatim (single component => no hash)
    expect(stack.getLogicalId(stack.l1)).toBe('RawBucket');
    expect(stack.l1.node.defaultChild).toBeUndefined();
  });

  test('L2 adds defaults (BlockPublicAccess) and a BucketPolicy for enforceSSL', () => {
    const l1 = stack.l2.node.defaultChild as s3.CfnBucket;
    expect(l1).toBeInstanceOf(s3.CfnBucket);
    expect(stack.getLogicalId(l1)).toMatch(/^NiceBucket[0-9A-F]{8}$/);
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      Bucket: { Ref: stack.getLogicalId(l1) },
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Action: 's3:*' })]) },
    });
  });

  test('L3 composes two L2s: archive bucket logs to the access-log bucket, lifecycle tiers to Glacier IR', () => {
    template.resourceCountIs('AWS::S3::Bucket', 4); // raw + nice + archive + access logs
    const logsId = stack.getLogicalId(stack.l3.accessLogs.node.defaultChild as cdk.CfnResource);
    template.hasResourceProperties('AWS::S3::Bucket', {
      LoggingConfiguration: { DestinationBucketName: { Ref: logsId }, LogFilePrefix: 'archive/' },
      LifecycleConfiguration: {
        Rules: [Match.objectLike({ Id: 'tier-to-glacier-ir', Transitions: [{ StorageClass: 'GLACIER_IR', TransitionInDays: 30 }] })],
      },
    });
    // The L3 is a plain Construct: it has no defaultChild and no logical ID of its own.
    expect(stack.l3.node.defaultChild).toBeUndefined();
  });

  test('the serverAccessLogsUseBucketPolicy flag decides policy vs ACL on the log bucket', () => {
    // flag on: a bucket policy statement for logging.s3.amazonaws.com, no ACL
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: 'logging.s3.amazonaws.com' }, Action: 's3:PutObject' })]) },
    });
    // flag off (bare App): the legacy LogDeliveryWrite ACL + ObjectWriter ownership
    const legacy = new LevelsStack(new cdk.App(), 'L', { tier: 'dev' });
    Template.fromStack(legacy).hasResourceProperties('AWS::S3::Bucket', {
      AccessControl: 'LogDeliveryWrite',
      OwnershipControls: { Rules: [{ ObjectOwnership: 'ObjectWriter' }] },
    });
  });

  test('removal policy follows the tier', () => {
    const prodStack = new LevelsStack(new cdk.App({ context: LOGS_VIA_POLICY }), 'P', { tier: 'prod' });
    const archiveId = prodStack.getLogicalId(prodStack.l3.bucket.node.defaultChild as cdk.CfnResource);
    Template.fromStack(prodStack).hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    expect(Template.fromStack(prodStack).toJSON().Resources[archiveId].DeletionPolicy).toBe('Retain');
  });
});

describe('01 · logical IDs', () => {
  test('predictLogicalId reproduces the framework for depth 1, depth n, Default and dedupe', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    const a = new s3.Bucket(stack, 'A');
    const scope = new cdk.Stack(app, 'S2');
    const grp = new Construct(scope, 'Grp');
    const inner = new s3.Bucket(grp, 'Grp'); // consecutive duplicate: Grp/Grp/Resource
    const def = new s3.Bucket(new Construct(scope, 'Default'), 'Hidden');
    const out = new cdk.CfnOutput(stack, 'Out', { value: 'x' });

    const id = (c: cdk.CfnElement) => cdk.Stack.of(c).getLogicalId(c);
    expect(predictLogicalId(['A', 'Resource'])).toBe(id(a.node.defaultChild as cdk.CfnElement));
    expect(predictLogicalId(['Grp', 'Grp', 'Resource'])).toBe(id(inner.node.defaultChild as cdk.CfnElement));
    expect(predictLogicalId(['Grp', 'Grp', 'Resource'])).toMatch(/^Grp[0-9A-F]{8}$/);
    expect(predictLogicalId(['Default', 'Hidden', 'Resource'])).toBe(id(def.node.defaultChild as cdk.CfnElement));
    expect(predictLogicalId(['Default', 'Hidden', 'Resource'])).toBe(predictLogicalId(['Hidden', 'Resource']));
    expect(predictLogicalId(['Out'])).toBe('Out');
    expect(id(out)).toBe('Out');
  });

  test('describeIds: uniqueId hashes the full path, logicalId is stack-relative', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'M01-X');
    const bucket = new s3.Bucket(stack, 'Data');
    const ids = describeIds(bucket);
    expect(ids.path).toBe('M01-X/Data');
    expect(ids.uniqueId).toMatch(/^M01XData[0-9A-F]{8}$/);
    expect(ids.logicalId).toMatch(/^Data[0-9A-F]{8}$/);
    expect(ids.uniqueResourceName).toMatch(/^M01X-Data-[0-9A-F]{8}$/); // non-alphanumerics stripped per component, separator between
    expect(ids.uniqueResourceName.length).toBeLessThanOrEqual(64);
  });

  test('allocateLogicalId override prefixes every resource, and overrideLogicalId still wins', () => {
    const app = new cdk.App();
    const stack = new PrefixedIdsStack(app, 'M01-LogicalIds', { logicalIdPrefix: 'Dev' });
    const template = Template.fromStack(stack);
    const ids = Object.keys(template.toJSON().Resources);
    expect(ids).toContain('LegacyParameter'); // pinned
    expect(ids.filter((i) => i !== 'LegacyParameter').every((i) => i.startsWith('Dev'))).toBe(true);
    template.hasParameter('BootstrapVersion', {}); // synthesizer elements untouched

    // stack.getLogicalId ignores the override; the element's logicalId token does not.
    const pinned = stack.pinned.node.defaultChild as cdk.CfnResource;
    expect(stack.getLogicalId(pinned)).toMatch(/^DevRenamedParameter[0-9A-F]{8}$/);
    expect(stack.resolve(pinned.logicalId)).toBe('LegacyParameter');
  });

  test('exercise 1: a scope named Default is invisible to logical IDs', () => {
    const app = new cdk.App();
    const stack = new DefaultScopeStack(app, 'S');
    const jobs = stack.grouped.jobs.node.defaultChild as cdk.CfnResource;
    expect(jobs.node.path).toBe('S/Default/Jobs/Resource');
    expect(stack.getLogicalId(jobs)).toBe(predictLogicalId(['Jobs', 'Resource']));

    // The other side of the coin: two elements that collapse to the same ID fail synth.
    const sq = new cdk.Stack(new cdk.App(), 'Q');
    const q1 = new cdk.CfnResource(new Construct(sq, 'Default'), 'Thing', { type: 'AWS::SNS::Topic' });
    const q2 = new cdk.CfnResource(sq, 'Thing', { type: 'AWS::SNS::Topic' });
    expect(sq.getLogicalId(q1)).toBe(sq.getLogicalId(q2));
    expect(() => Template.fromStack(sq)).toThrow(/section 'Resources' already contains 'Thing'/);
  });

  test('exercise 3: renameLogicalId and overrideLogicalId keep deployed IDs across a refactor', () => {
    const app = new cdk.App();
    const stack = new RefactoredStack(app, 'S', { deployedIds: { orders: 'Orders1234ABCD', events: 'EventsAB12CD34' } });
    const resources = Template.fromStack(stack).toJSON().Resources;
    expect(resources.Orders1234ABCD.Type).toBe('AWS::DynamoDB::GlobalTable');
    expect(resources.EventsAB12CD34.Type).toBe('AWS::SQS::Queue');
    expect(Object.keys(resources).some((k) => k.startsWith('StorageOrders'))).toBe(false);
  });
});

describe('01 · tokens', () => {
  const app = new cdk.App();
  const stack = new TokensStack(app, 'M01-Tokens', { tier: 'dev' });
  const template = Template.fromStack(stack);
  const bucketId = stack.getLogicalId(stack.bucket.node.defaultChild as cdk.CfnResource);
  const queueId = stack.getLogicalId(stack.queue.node.defaultChild as cdk.CfnResource);

  test('a bucket name is a string token that resolves to Ref', () => {
    expect(cdk.Token.isUnresolved(stack.bucket.bucketName)).toBe(true);
    expect(stack.bucket.bucketName).toMatch(/^\$\{Token\[TOKEN\.\d+\]\}$/);
    expect(stack.rendered.bucketName).toEqual({ Ref: bucketId });
  });

  test('interpolation becomes Fn::Join; Fn helpers become their intrinsics', () => {
    expect(stack.rendered.objectUrl).toEqual({ 'Fn::Join': ['', ['s3://', { Ref: bucketId }, '/dev/manifest.json']] });
    expect(stack.rendered.queueAccount).toEqual({
      'Fn::Select': [4, { 'Fn::Split': [':', { 'Fn::GetAtt': [queueId, 'Arn'] }] }],
    });
    expect(stack.rendered.subbed).toEqual({ 'Fn::Sub': ['arn:${AWS::Partition}:s3:::${BucketName}/*', { BucketName: { Ref: bucketId } }] });
    expect(stack.rendered.joined).toEqual({ 'Fn::Join': ['/', [{ 'Fn::GetAtt': [bucketId, 'Arn'] }, 'prefix/*']] });
  });

  test('Lazy values see mutations made after they were created', () => {
    expect(stack.rendered.handlerCount).toBe(2);
    template.hasResourceProperties('AWS::SSM::Parameter', { Type: 'StringList', Value: { 'Fn::Join': [',', ['billing', 'orders']] } });
    template.hasResourceProperties('AWS::SSM::Parameter', { Value: '2 handlers registered' });
  });

  test('region is a token in an env-agnostic stack; Aws.REGION is the same pseudo-parameter', () => {
    expect(stack.rendered.region).toEqual({ Ref: 'AWS::Region' });
    expect(stack.rendered.awsRegion).toEqual({ Ref: 'AWS::Region' });
  });

  test('Duration and Size are units, not tokens', () => {
    template.hasOutput('RetentionSeconds', { Value: '345600' });
    template.hasOutput('BatchGiB', { Value: '0.25' });
    expect(cdk.Duration.parse('PT1H30M').toMinutes()).toBe(90);
    expect(() => cdk.Duration.minutes(90).toHours()).toThrow(/cannot be converted into a whole number/);
    expect(cdk.Duration.minutes(90).toHours({ integral: false })).toBe(1.5);
  });

  test('why .toUpperCase()/.length on a token is a bug', () => {
    const literal = 'my-bucket';
    expect(namingBug(literal)).toBe('MY-BUCKE-index');
    // On a token the "same" function mangles the placeholder: the result is not a token
    // CDK can resolve, so the template would contain the literal text "${TOKEN[…".
    const mangled = namingBug(stack.bucket.bucketName);
    expect(mangled.startsWith('${TOKEN[')).toBe(true);
    expect(cdk.Token.isUnresolved(mangled)).toBe(false);
    expect(stack.bucket.bucketName.length).toBeGreaterThan(0); // meaningless: length of the placeholder
    // The fix composes instead of inspecting.
    expect(stack.resolve(namingFix(stack.bucket.bucketName))).toEqual({ 'Fn::Join': ['', [{ Ref: bucketId }, '-index']] });
    expect(namingFix(literal)).toBe('MY-BUCKE-index');
  });

  test('classify: Tokenization.isResolvable vs Token.isUnresolved', () => {
    expect(classify(cdk.Lazy.any({ produce: () => 1 }))).toBe('resolvable');
    expect(classify(stack.bucket.bucketName)).toBe('string-token');
    expect(classify(cdk.Lazy.number({ produce: () => 1 }))).toBe('number-token');
    expect(classify(cdk.Lazy.list({ produce: () => [] }))).toBe('list-token');
    expect(classify('plain')).toBe('literal');
    expect(classify(['a', 'b'])).toBe('literal');
  });

  test('exercise 2: token guards', () => {
    expect(requireLiteral('abc', 'name')).toBe('abc');
    expect(() => requireLiteral(stack.bucket.bucketName, 'bucket name')).toThrow(/must be known at synth time/);
    expect(withSuffix('data', 'logs')).toBe('data-logs');
    expect(() => withSuffix('a'.repeat(60), 'logs')).toThrow(/exceeds 63/);
    expect(stack.resolve(withSuffix(stack.bucket.bucketName, 'logs'))).toEqual({ 'Fn::Join': ['-', [{ Ref: bucketId }, 'logs']] });
    expect(isWithin(5, 1, 10)).toBe(true);
    expect(isWithin(cdk.Lazy.number({ produce: () => 5 }), 1, 10)).toBeUndefined();
    expect(third(['a', 'b', 'c'])).toBe('c');
    const azs = cdk.Fn.getAzs();
    expect(stack.resolve(third(azs))).toEqual({ 'Fn::Select': [2, { 'Fn::GetAZs': '' }] });
  });
});

describe('01 · CfnParameter, CfnOutput, Annotations', () => {
  test('parameter flows into the template as Ref; output is exported', () => {
    const app = new cdk.App();
    const stack = new ParametersStack(app, 'M01-Parameters', { tier: 'dev' });
    const template = Template.fromStack(stack);
    template.hasParameter('AlertEmail', { Type: 'String', ConstraintDescription: 'must be an email address' });
    template.hasResourceProperties('AWS::SNS::Subscription', { Endpoint: { Ref: 'AlertEmail' }, Protocol: 'email' });
    template.hasOutput('TopicArn', { Export: { Name: 'cdk-mastery-dev-alerts-topic-arn' } });
    template.hasResourceProperties('AWS::SSM::Parameter', { Value: 'platform-team@example.com' });
  });

  test('context replaces the parameter at synth time (testable, diffable)', () => {
    const app = new cdk.App({ context: { 'cdk-mastery:alertEmail': 'oncall@example.com' } });
    const stack = new ParametersStack(app, 'M01-Parameters', { tier: 'prod' });
    Template.fromStack(stack).hasResourceProperties('AWS::SSM::Parameter', { Value: 'oncall@example.com' });
  });

  test('annotations: warning in dev, info always, error only when misconfigured', () => {
    const dev = new ParametersStack(new cdk.App(), 'Dev', { tier: 'dev' });
    Annotations.fromStack(dev).hasWarning('/Dev', Match.stringLikeRegexp('prefer context or props'));
    Annotations.fromStack(dev).hasInfo('/Dev/Alerts', Match.stringLikeRegexp('email subscription'));
    Annotations.fromStack(dev).hasNoError('/Dev', Match.anyValue());

    const prod = new ParametersStack(new cdk.App(), 'Prod', { tier: 'prod' });
    Annotations.fromStack(prod).hasNoWarning('/Prod', Match.anyValue());

    const bad = new ParametersStack(new cdk.App(), 'Bad', { tier: 'prod', simulateMisconfiguration: true });
    Annotations.fromStack(bad).hasError('/Bad', Match.stringLikeRegexp('simulateMisconfiguration was set'));
  });
});

describe('01 · addToApp', () => {
  test('registers four env-agnostic stacks with the M01- prefix', () => {
    const app = new cdk.App();
    addToApp(app);
    const stacks = app.node.children.filter((c): c is cdk.Stack => cdk.Stack.isStack(c));
    expect(stacks.map((s) => s.stackName).sort()).toEqual(['M01-Levels', 'M01-LogicalIds', 'M01-Parameters', 'M01-Tokens']);
    for (const s of stacks) expect(cdk.Token.isUnresolved(s.account)).toBe(true);
  });
});
