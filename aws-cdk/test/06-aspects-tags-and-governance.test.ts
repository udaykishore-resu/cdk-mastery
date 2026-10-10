import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import {
  ConstructPolicyAspect,
  EnforceBucketEncryptionAspect,
  GovernedStack,
  LogRetentionAspect,
  MandatoryTagsPlugin,
  NoPublicBucketsAspect,
  RequireTagsAspect,
  applyAwsSolutionsChecks,
  applyGovernance,
  nagFindings,
  retentionFromDays,
} from '../src/modules/06-aspects-tags-and-governance';
import { RetainStatefulAspect } from '../src/modules/06-aspects-tags-and-governance/solutions/exercise-1-retain-stateful-aspect';
import { LambdaRuntimeAspect } from '../src/modules/06-aspects-tags-and-governance/solutions/exercise-2-lambda-runtime-aspect';
import { HouseRulesPack } from '../src/modules/06-aspects-tags-and-governance/solutions/exercise-3-house-rules-pack';
import { PascalCaseIds } from '@cdk-mastery/shared';

const MANDATORY = ['environment', 'service', 'owner', 'cost-center', 'managed-by'];

function governed(includeViolations = false, tier = ENVIRONMENTS.dev) {
  const app = new cdk.App();
  const stack = new GovernedStack(app, 'Governed', { tier, includeViolations });
  return { app, stack, template: Template.fromStack(stack) };
}

describe('06 · mutating aspects', () => {
  test('EnforceBucketEncryptionAspect adds SSE-S3 to a bucket that declared no encryption', () => {
    const { template } = governed();
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    });
  });

  test('EnforceBucketEncryptionAspect respects an explicit choice and can do SSE-KMS', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    new s3.Bucket(stack, 'Explicit', { encryption: s3.BucketEncryption.S3_MANAGED });
    new s3.Bucket(stack, 'Implicit');
    cdk.Aspects.of(stack).add(new EnforceBucketEncryptionAspect({ kmsKeyArn: 'arn:aws:kms:us-east-1:111111111111:key/abc' }), {
      priority: cdk.AspectPriority.MUTATING,
    });
    const template = Template.fromStack(stack);
    template.resourcePropertiesCountIs(
      'AWS::S3::Bucket',
      { BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] } },
      1,
    );
    template.resourcePropertiesCountIs(
      'AWS::S3::Bucket',
      {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { BucketKeyEnabled: true, ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: 'arn:aws:kms:us-east-1:111111111111:key/abc' } },
          ],
        },
      },
      1,
    );
  });

  test('LogRetentionAspect sets the tier default (dev = 7 days) on a log group with no retention', () => {
    const { template } = governed();
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  });

  test('LogRetentionAspect clamps over-long retention in non-prod and says so', () => {
    const { stack, template } = governed(true);
    // The 400-day group was clamped to 7 (ONE_WEEK); no log group in the stack keeps 400.
    template.resourcePropertiesCountIs('AWS::Logs::LogGroup', { RetentionInDays: 400 }, 0);
    Annotations.fromStack(stack).hasInfo('/Governed/Chatty/Resource', Match.stringLikeRegexp('clamped retention from 400 to 7'));
  });

  test('LogRetentionAspect leaves prod retention alone (no ceiling)', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    new logs.LogGroup(stack, 'Long', { retention: logs.RetentionDays.THIRTEEN_MONTHS });
    cdk.Aspects.of(stack).add(new LogRetentionAspect({ defaultRetention: retentionFromDays(365) }));
    Template.fromStack(stack).hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 400 });
  });

  test('retentionFromDays maps tier values onto the RetentionDays enum, rounding up', () => {
    expect(retentionFromDays(7)).toBe(logs.RetentionDays.ONE_WEEK);
    expect(retentionFromDays(30)).toBe(logs.RetentionDays.ONE_MONTH);
    expect(retentionFromDays(365)).toBe(logs.RetentionDays.ONE_YEAR);
    expect(retentionFromDays(8)).toBe(logs.RetentionDays.TWO_WEEKS);
  });
});

describe('06 · tags and inheritance', () => {
  test('every taggable resource carries the mandatory tags derived from the tier', () => {
    const { template } = governed();
    const expectedTags = Match.arrayWith([
      { Key: 'cost-center', Value: 'cc-platform-dev' },
      { Key: 'environment', Value: 'dev' },
      { Key: 'managed-by', Value: 'cdk-mastery' },
      { Key: 'owner', Value: 'platform-team' },
      { Key: 'service', Value: 'governance' },
    ]);
    for (const type of ['AWS::S3::Bucket', 'AWS::SQS::Queue', 'AWS::Lambda::Function', 'AWS::Logs::LogGroup']) {
      const count = Object.keys(template.findResources(type)).length;
      template.resourcePropertiesCountIs(type, { Tags: expectedTags }, count);
    }
  });

  test('includeResourceTypes limits a tag to the listed types', () => {
    const { template } = governed();
    template.hasResourceProperties('AWS::S3::Bucket', { Tags: Match.arrayWith([{ Key: 'data-classification', Value: 'internal' }]) });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Tags: Match.not(Match.arrayWith([{ Key: 'data-classification', Value: Match.anyValue() }])),
    });
  });

  test('closest tag wins at equal priority; a higher-priority ancestor tag beats a closer one', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    const bucket = new s3.Bucket(stack, 'B', { blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true });
    applyGovernance(stack, { tier: ENVIRONMENTS.dev, service: 'svc' });
    cdk.Tags.of(bucket).add('owner', 'team-x'); // same default priority (100), closer → wins
    cdk.Tags.of(bucket).add('data-classification', 'public'); // priority 100 < 200 set by applyGovernance → loses
    const template = Template.fromStack(stack);
    // Tags render sorted by key, and `arrayWith` is order-sensitive (it matches a subsequence).
    template.hasResourceProperties('AWS::S3::Bucket', {
      Tags: Match.arrayWith([
        { Key: 'data-classification', Value: 'internal' },
        { Key: 'owner', Value: 'team-x' },
      ]),
    });
  });
});

describe('06 · read-only aspects and ordering', () => {
  test('a compliant stack produces no annotation errors', () => {
    const { stack } = governed();
    Annotations.fromStack(stack).hasNoError('*', Match.anyValue());
  });

  test('NoPublicBucketsAspect flags a bucket without a full public-access block', () => {
    const { stack } = governed(true);
    Annotations.fromStack(stack).hasError('/Governed/Leaky/Resource', Match.stringLikeRegexp('NoPublicBucketsAspect'));
    // The compliant bucket is not flagged.
    Annotations.fromStack(stack).hasNoError('/Governed/Artifacts/Resource', Match.anyValue());
  });

  test('ConstructPolicyAspect bridges the shared PascalCaseIds rule into Annotations', () => {
    const { stack } = governed(true);
    Annotations.fromStack(stack).hasError('/Governed/bad_name', Match.stringLikeRegexp('naming/pascal-case-ids'));
  });

  test('RequireTagsAspect gives false positives when it runs before the Tags aspect', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    new sqs.Queue(stack, 'Q');
    cdk.Tags.of(stack).add('owner', 'me'); // Tags aspect: DEFAULT (500) without the aspectPrioritiesMutating flag
    cdk.Aspects.of(stack).add(new RequireTagsAspect({ requiredKeys: ['owner'] }), { priority: 100 }); // runs first → wrong
    Annotations.fromStack(stack).hasError('/S/Q/Resource', Match.stringLikeRegexp('missing required tag'));
  });

  test('RequireTagsAspect at READONLY priority sees the final tag set', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    new sqs.Queue(stack, 'Q');
    cdk.Tags.of(stack).add('owner', 'me');
    cdk.Aspects.of(stack).add(new RequireTagsAspect({ requiredKeys: ['owner'] }), { priority: cdk.AspectPriority.READONLY });
    Annotations.fromStack(stack).hasNoError('*', Match.anyValue());
  });

  test('aspects run in priority order: MUTATING < DEFAULT < READONLY, then inherited before local', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    const order: string[] = [];
    const record = (label: string): cdk.IAspect => ({ visit: (n) => { if (n === stack) order.push(label); } });
    cdk.Aspects.of(stack).add(record('default'));
    cdk.Aspects.of(stack).add(record('readonly'), { priority: cdk.AspectPriority.READONLY });
    cdk.Aspects.of(app).add(record('app-readonly'), { priority: cdk.AspectPriority.READONLY });
    cdk.Aspects.of(stack).add(record('mutating'), { priority: cdk.AspectPriority.MUTATING });
    Template.fromStack(stack);
    expect(order).toEqual(['mutating', 'default', 'app-readonly', 'readonly']);
    expect(cdk.AspectPriority.MUTATING).toBeLessThan(cdk.AspectPriority.DEFAULT);
    expect(cdk.AspectPriority.DEFAULT).toBeLessThan(cdk.AspectPriority.READONLY);
  });

  test('with annotationsInValidationReport on (as in cdk.json), annotation errors fail synthesis', () => {
    const app = new cdk.App({ context: { '@aws-cdk/core:annotationsInValidationReport': true } });
    const stack = new cdk.Stack(app, 'S');
    new s3.Bucket(stack, 'Leaky');
    cdk.Aspects.of(stack).add(new NoPublicBucketsAspect(), { priority: cdk.AspectPriority.READONLY });
    expect(() => app.synth()).toThrow(/NoPublicBucketsAspect/);
  });
});

describe('06 · permissions boundary', () => {
  test('every role in the stack references the boundary managed policy', () => {
    const { template } = governed();
    const roles = template.findResources('AWS::IAM::Role');
    expect(Object.keys(roles).length).toBeGreaterThan(0);
    template.resourcePropertiesCountIs(
      'AWS::IAM::Role',
      { PermissionsBoundary: { Ref: Match.stringLikeRegexp('^BoundaryPolicy') } },
      Object.keys(roles).length,
    );
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'revan-governance-dev-boundary',
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Sid: 'DenyBoundaryEscape', Effect: 'Deny' })]) },
    });
  });
});

describe('06 · cdk-nag (v3 validation plugin)', () => {
  test('the governed stack has zero unacknowledged errors', () => {
    const { app, stack } = governed();
    app.synth(); // aspects must run before nag looks at the tree
    const errors = nagFindings(stack).filter((f) => f.severity === 'error');
    expect(errors).toEqual([]);
  });

  test('an un-hardened bucket produces AwsSolutions-S1 and S10 findings', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    new s3.Bucket(stack, 'Plain');
    app.synth();
    const ids = nagFindings(stack).map((f) => f.ruleId).sort();
    expect(ids).toEqual(expect.arrayContaining(['AwsSolutions-S1', 'AwsSolutions-S10']));
  });

  test('registered on the App, a violation makes synthesis throw with the report', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    new s3.Bucket(stack, 'Plain');
    applyAwsSolutionsChecks(app);
    expect(() => app.synth()).toThrow(/AwsSolutions-S1/);
  });

  test('acknowledging on an ancestor suppresses for every descendant', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    new s3.Bucket(stack, 'Plain');
    applyAwsSolutionsChecks(app);
    cdk.Validations.of(stack).acknowledge(
      { id: 'AwsSolutions-S1', reason: 'test: access logs handled by org-level CloudTrail data events' },
      { id: 'AwsSolutions-S10', reason: 'test: SSL enforced by SCP aws:SecureTransport deny' },
    );
    expect(() => app.synth()).not.toThrow();
  });
});

describe('06 · MandatoryTagsPlugin (a validation plugin, post-synthesis)', () => {
  test('fails synthesis when a listed resource type lacks a mandatory tag', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    new sqs.Queue(stack, 'Q');
    cdk.Validations.of(app).addPlugins(new MandatoryTagsPlugin({ requiredKeys: MANDATORY, resourceTypes: ['AWS::SQS::Queue'] }));
    expect(() => app.synth()).toThrow(/tags\/mandatory-keys/);
  });

  test('passes once applyGovernance has tagged the tree', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    new sqs.Queue(stack, 'Q');
    applyGovernance(stack, { tier: ENVIRONMENTS.dev, service: 'svc' });
    cdk.Validations.of(app).addPlugins(new MandatoryTagsPlugin({ requiredKeys: MANDATORY, resourceTypes: ['AWS::SQS::Queue'] }));
    expect(() => app.synth()).not.toThrow();
  });
});

describe('06 · exercises', () => {
  test('exercise 1: RetainStatefulAspect warns on a DESTROY bucket only when enforcing', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    new s3.Bucket(stack, 'Ephemeral', { removalPolicy: cdk.RemovalPolicy.DESTROY });
    new s3.Bucket(stack, 'Kept', { removalPolicy: cdk.RemovalPolicy.RETAIN });
    cdk.Aspects.of(stack).add(new RetainStatefulAspect({ enforce: ENVIRONMENTS.prod.retainStatefulResources }), {
      priority: cdk.AspectPriority.READONLY,
    });
    const annotations = Annotations.fromStack(stack);
    annotations.hasWarning('/S/Ephemeral/Resource', Match.stringLikeRegexp('RetainStatefulAspect'));
    annotations.hasNoWarning('/S/Kept/Resource', Match.anyValue());

    const app2 = new cdk.App();
    const stack2 = new cdk.Stack(app2, 'S');
    new s3.Bucket(stack2, 'Ephemeral', { removalPolicy: cdk.RemovalPolicy.DESTROY });
    cdk.Aspects.of(stack2).add(new RetainStatefulAspect({ enforce: ENVIRONMENTS.dev.retainStatefulResources }));
    Annotations.fromStack(stack2).hasNoWarning('*', Match.anyValue());
  });

  test('exercise 2: LambdaRuntimeAspect upgrades deprecated runtimes and leaves current ones alone', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    const code = lambda.Code.fromInline('exports.handler = async () => 1;');
    new lambda.Function(stack, 'Old', { runtime: lambda.Runtime.NODEJS_18_X, handler: 'index.handler', code });
    new lambda.Function(stack, 'New', { runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler', code });
    cdk.Aspects.of(stack).add(new LambdaRuntimeAspect(), { priority: cdk.AspectPriority.MUTATING });
    const template = Template.fromStack(stack);
    template.resourcePropertiesCountIs('AWS::Lambda::Function', { Runtime: 'nodejs22.x' }, 2);
    Annotations.fromStack(stack).hasInfo('/S/Old/Resource', Match.stringLikeRegexp('nodejs18.x -> nodejs22.x'));
  });

  test('exercise 3: HouseRulesPack reports queues without an adequate redrive policy and honours acknowledgements', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    const dlq = new sqs.Queue(stack, 'Dlq');
    new sqs.Queue(stack, 'NoDlq');
    new sqs.Queue(stack, 'Trigger', { deadLetterQueue: { queue: dlq, maxReceiveCount: 1 } });
    new sqs.Queue(stack, 'Good', { deadLetterQueue: { queue: dlq, maxReceiveCount: 5 } });
    cdk.Validations.of(dlq).acknowledge({ id: 'HouseRules-SqsRedrivePolicy', reason: 'this is the DLQ' });

    const report = new HouseRulesPack(undefined, { verbose: true }).validateScope(stack);
    expect(report.success).toBe(false);
    const paths = report.violations.flatMap((v) => v.violatingResources.map((r) => r.constructPath)).sort();
    expect(paths).toEqual(['S/NoDlq/Resource', 'S/Trigger/Resource']);
    expect(report.violations[0].ruleName).toBe('HouseRules-SqsRedrivePolicy');
    expect(report.violations[0].description).toMatch(/maxReceiveCount below 3/);
  });

  test('the shared ConstructPolicy can also be handed to Aspects directly (structural IAspect match)', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    new sqs.Queue(stack, 'fine');
    const aspect = new ConstructPolicyAspect([PascalCaseIds]);
    cdk.Aspects.of(stack).add(aspect.policy); // ConstructPolicy itself, no bridge
    Template.fromStack(stack);
    expect(aspect.policy.violations.map((v) => v.path)).toEqual(['S/fine']);
  });
});
