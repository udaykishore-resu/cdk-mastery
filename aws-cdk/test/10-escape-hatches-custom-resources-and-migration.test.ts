import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import {
  BundledConfigAsset,
  CfnIncludeStack,
  CustomResourcesStack,
  EscapeHatchesStack,
  ParameterWriter,
  SlowResource,
  deepMerge,
} from '../src/modules/10-escape-hatches-custom-resources-and-migration';
import { CfnLintIgnoreAspect } from '../src/modules/10-escape-hatches-custom-resources-and-migration/solutions/exercise-1-cfn-lint-metadata-aspect';
import { ParameterReader } from '../src/modules/10-escape-hatches-custom-resources-and-migration/solutions/exercise-2-parameter-reader';
import { S3ObjectWriter } from '../src/modules/10-escape-hatches-custom-resources-and-migration/solutions/exercise-3-s3-object-writer';

const MODULE_DIR = path.join(__dirname, '../src/modules/10-escape-hatches-custom-resources-and-migration');

/** Flatten an `Fn::Join` (strings + intrinsics) into one string so JSON-in-a-string properties can be inspected. */
function renderJoin(value: unknown): string {
  if (typeof value === 'string') return value;
  const join = (value as { 'Fn::Join'?: [string, unknown[]] })['Fn::Join'];
  if (!join) return JSON.stringify(value);
  return join[1].map((part) => (typeof part === 'string' ? part : `<${JSON.stringify(part)}>`)).join(join[0]);
}

describe('10 · the escape-hatch ladder', () => {
  let template: Template;
  let stack: EscapeHatchesStack;
  beforeAll(() => {
    const app = new cdk.App();
    stack = new EscapeHatchesStack(app, 'Hatches');
    template = Template.fromStack(stack);
  });

  test('rung 2: defaultChild as CfnBucket sets a typed L1 property the L2 does not expose', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      AnalyticsConfigurations: [
        Match.objectLike({
          Id: 'whole-bucket',
          StorageClassAnalysis: { DataExport: Match.objectLike({ OutputSchemaVersion: 'V_1', Destination: Match.objectLike({ Format: 'CSV', Prefix: 'analytics/' }) }) },
        }),
      ],
    });
  });

  test('rung 3: addPropertyOverride with an array index path replaces what the L2 rendered', () => {
    // The L2 rendered BucketOwnerPreferred; the override wins because overrides are applied last.
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    });
    template.resourcePropertiesCountIs('AWS::S3::Bucket', { OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }] } }, 0);
  });

  test('rung 4: addOverride reaches Metadata and UpdateReplacePolicy, merging with what CDK wrote', () => {
    template.hasResource('AWS::S3::Bucket', {
      Properties: Match.objectLike({ VersioningConfiguration: { Status: 'Enabled' } }),
      Metadata: Match.objectLike({ 'cdk-mastery': { owner: 'platform-team', 'escape-hatches': ['analyticsConfigurations', 'OwnershipControls override'] } }),
      UpdateReplacePolicy: 'Retain',
      DeletionPolicy: 'Retain', // the L2 default; the override only touched UpdateReplacePolicy
    });
  });

  test('rung 5: addPropertyDeletionOverride removes the allow-all egress the L2 always renders', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'egress managed externally',
      SecurityGroupEgress: Match.absent(),
    });
  });

  test('rung 6: tryRemoveChild drops the grant-generated DefaultPolicy; the external policy is attached by name', () => {
    template.resourceCountIs('AWS::IAM::Policy', 0);
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, ':policy/orders-worker-runtime']] },
      ]),
    });
    expect(stack.fn.role!.node.tryFindChild('DefaultPolicy')).toBeUndefined();
  });

  test('overrideLogicalId pins the logical ID for cdk import; RETAIN keeps the bucket on delete', () => {
    const resources = template.toJSON().Resources as Record<string, { Type: string; DeletionPolicy?: string }>;
    expect(resources.LegacyAssetsBucket).toEqual(expect.objectContaining({ Type: 'AWS::S3::Bucket', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' }));
    // Construct id 'AdoptedAssets' is nowhere in the template: the override replaced the generated id entirely.
    expect(Object.keys(resources).some((id) => id.startsWith('AdoptedAssets'))).toBe(false);

    const custom = new EscapeHatchesStack(new cdk.App(), 'H2', { legacyBucketLogicalId: 'AssetsBucket2019' });
    expect(Object.keys(Template.fromStack(custom).toJSON().Resources)).toContain('AssetsBucket2019');
  });

  test('rung 7: a raw CfnResource renders exactly the properties given', () => {
    template.hasResource('AWS::SSM::Parameter', {
      Properties: { Name: '/cdk-mastery/10/raw-resource', Type: 'String', Value: 'written by a raw CfnResource' },
    });
  });

  test('overrides are visible to Template assertions but not to aspects (they apply at render time)', () => {
    const app = new cdk.App();
    const s = new cdk.Stack(app, 'S');
    const bucket = new s3.Bucket(s, 'B');
    const cfn = bucket.node.defaultChild as s3.CfnBucket;
    cfn.addPropertyOverride('VersioningConfiguration.Status', 'Enabled');
    let seenByAspect: unknown = 'unset';
    cdk.Aspects.of(s).add({ visit: (n) => { if (n === cfn) seenByAspect = cfn.versioningConfiguration; } });
    Template.fromStack(s).hasResourceProperties('AWS::S3::Bucket', { VersioningConfiguration: { Status: 'Enabled' } });
    expect(seenByAspect).toBeUndefined(); // the L1 property bag never changed; only the rendered JSON did
  });
});

describe('10 · cloudformation-include', () => {
  let template: Template;
  let stack: CfnIncludeStack;
  beforeAll(() => {
    stack = new CfnIncludeStack(new cdk.App(), 'Legacy', { environment: 'dev' });
    template = Template.fromStack(stack);
  });

  test('every legacy element keeps its original logical ID', () => {
    const ids = Object.keys(template.toJSON().Resources);
    expect(ids).toEqual(expect.arrayContaining(['OrdersTopic', 'OrdersQueue', 'OrdersDeadLetterQueue', 'OrdersQueuePolicy', 'OrdersSubscription', 'OrdersAlarmTopic']));
    // The DLQ's hand-written DeletionPolicy survives adoption.
    template.hasResource('AWS::SQS::Queue', { Properties: Match.objectLike({ QueueName: { 'Fn::Sub': 'orders-inbox-dlq-dev' } }), DeletionPolicy: 'Retain' });
    template.hasOutput('QueueUrl', { Value: { Ref: 'OrdersQueue' }, Export: { Name: { 'Fn::Sub': 'orders-inbox-url-dev' } } });
  });

  test('a supplied parameter is baked in and disappears; the others stay deploy-time inputs', () => {
    const params = template.toJSON().Parameters as Record<string, unknown>;
    expect(params.Environment).toBeUndefined();
    template.hasParameter('MessageRetentionSeconds', { Type: 'Number', Default: 345600 });
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: { 'Fn::Sub': 'orders-inbox-dev' }, MessageRetentionPeriod: { Ref: 'MessageRetentionSeconds' } });
    template.hasCondition('IsProd', { 'Fn::Equals': ['dev', 'prod'] });
    template.hasResource('AWS::SNS::Topic', { Condition: 'IsProd' });
  });

  test('CDK code references included resources through getResource / getParameter / getOutput', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { QUEUE_URL: { Ref: 'OrdersQueue' }, TOPIC_ARN: { Ref: 'OrdersTopic' }, RETENTION: { Ref: 'MessageRetentionSeconds' } } },
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', { EventSourceArn: { 'Fn::GetAtt': ['OrdersQueue', 'Arn'] }, BatchSize: 5 });
    // The L2 wrapper granted consume permissions on the legacy queue ARN.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: Match.arrayWith(['sqs:ReceiveMessage']), Resource: { 'Fn::GetAtt': ['OrdersQueue', 'Arn'] } })]) },
    });
    template.hasOutput('QueueUrl', { Description: Match.stringLikeRegexp('now consumed by the CDK Consumer') });
  });

  test('included L1s accept escape hatches like any other', () => {
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: { 'Fn::Sub': 'orders-inbox-dev' }, SqsManagedSseEnabled: true });
  });

  test('the legacy template file is valid JSON with the elements the README describes', () => {
    const legacy = JSON.parse(fs.readFileSync(path.join(MODULE_DIR, 'legacy-template.json'), 'utf8'));
    expect(Object.keys(legacy.Resources)).toHaveLength(6);
    expect(Object.keys(legacy.Parameters)).toEqual(['Environment', 'MessageRetentionSeconds']);
    expect(legacy.Conditions.IsProd).toBeDefined();
  });
});

describe('10 · custom resources', () => {
  let template: Template;
  let stack: CustomResourcesStack;
  beforeAll(() => {
    stack = new CustomResourcesStack(new cdk.App(), 'CR');
    template = Template.fromStack(stack);
  });

  test('Provider framework: onEvent + isComplete handlers, a framework function and a waiter state machine', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'on-event.handler', Runtime: 'nodejs22.x' });
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'is-complete.handler', Runtime: 'nodejs22.x' });
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'framework.onEvent', Environment: { Variables: Match.objectLike({ USER_ON_EVENT_FUNCTION_ARN: Match.anyValue(), USER_IS_COMPLETE_FUNCTION_ARN: Match.anyValue() }) } });
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'framework.isComplete' });
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'framework.onTimeout' });
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    // queryInterval 10s and totalTimeout 10min become the waiter's retry parameters (60 × 10 s).
    // The definition is an Fn::Join (it embeds function ARNs), so flatten it before parsing.
    const [machine] = Object.values(template.findResources('AWS::StepFunctions::StateMachine'));
    const definition = JSON.parse(renderJoin(machine.Properties.DefinitionString).replace(/<[^>]+>/g, 'arn'));
    expect(definition.States['framework-isComplete-task'].Retry).toEqual([{ ErrorEquals: ['States.ALL'], IntervalSeconds: 10, MaxAttempts: 60, BackoffRate: 1 }]);
    expect(definition.States['framework-isComplete-task'].Catch[0].Next).toBe('framework-onTimeout-task');
  });

  test('the CustomResource carries a stable resourceType, its properties, and exposes attributes', () => {
    template.hasResourceProperties('Custom::SlowResource', {
      ServiceToken: { 'Fn::GetAtt': [Match.stringLikeRegexp('^SlowProviderframeworkonEvent'), 'Arn'] },
      Name: 'orders-index',
      WaitSeconds: 20,
    });
    template.hasOutput('SlowResult', { Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Slow'), 'Result'] } });
    expect(cdk.Token.isUnresolved(stack.slow.result)).toBe(true);
  });

  test('AwsCustomResource: SDK calls are serialised into Create/Update/Delete properties with a fixed physical id', () => {
    const [writer] = Object.values(template.findResources('Custom::SsmParameterWriter'));
    // Each call is JSON in a string; ours embeds a token, so it renders as an Fn::Join.
    const create = renderJoin(writer.Properties.Create);
    expect(create).toContain('"service":"SSM"');
    expect(create).toContain('"action":"PutParameter"');
    expect(create).toContain('"physicalResourceId":{"id":"/cdk-mastery/10/slow-result"}');
    expect(create).toContain('"Overwrite":true');
    // The value is another custom resource's attribute: a real dependency edge.
    expect(create).toMatch(/Fn::GetAtt.*Result/);
    expect(renderJoin(writer.Properties.Update)).toBe(create);
    expect(renderJoin(writer.Properties.Delete)).toContain('"ignoreErrorCodesMatching":"ParameterNotFound"');
    expect(writer.Properties.InstallLatestAwsSdk).toBe(false);
  });

  test('AwsCustomResource policy is derived from the SDK calls and scoped to the parameter ARN', () => {
    // One statement per SDK call here; under cdk.json's `@aws-cdk/aws-iam:minimizePolicies`
    // they merge into one statement with both actions. Either way the resource is the parameter ARN.
    const parameterArn = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ssm:', { Ref: 'AWS::Region' }, ':', { Ref: 'AWS::AccountId' }, ':parameter/cdk-mastery/10/slow-result']] };
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'ssm:PutParameter', Effect: 'Allow', Resource: parameterArn }),
          Match.objectLike({ Action: 'ssm:DeleteParameter', Effect: 'Allow', Resource: parameterArn }),
        ]),
      },
    });
    // One singleton Lambda serves every AwsCustomResource in the stack.
    template.resourcePropertiesCountIs('AWS::Lambda::Function', { Handler: 'index.handler', Runtime: Match.stringLikeRegexp('^nodejs') }, 1);
  });

  test('constructs can be used on their own in a throwaway stack', () => {
    const s = new cdk.Stack(new cdk.App(), 'T');
    new SlowResource(s, 'A', { name: 'a', waitSeconds: 1 });
    new SlowResource(s, 'B', { name: 'b', waitSeconds: 1 });
    new ParameterWriter(s, 'W', { parameterName: '/x/y', value: 'v' });
    const t = Template.fromStack(s);
    t.resourceCountIs('Custom::SlowResource', 2);
    t.resourceCountIs('AWS::StepFunctions::StateMachine', 2); // one Provider per SlowResource instance here — see README on sharing providers
  });
});

describe('10 · assets and local bundling', () => {
  test('local bundling runs without Docker, and the asset hash is computed over the output', () => {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'm10-assets-'));
    const app = new cdk.App({ outdir });
    const stack = new cdk.Stack(app, 'Assets');
    const config = new BundledConfigAsset(stack, 'Config', { sourcePath: path.join(MODULE_DIR, 'assets', 'config') });
    const assembly = app.synth();

    // The staged directory is the bundling *output*, named by hash.
    const staged = path.join(assembly.directory, `asset.${config.asset.assetHash}`);
    expect(fs.existsSync(path.join(staged, 'config.json'))).toBe(true);
    const merged = JSON.parse(fs.readFileSync(path.join(staged, 'config.json'), 'utf8'));
    expect(merged).toEqual({ service: 'orders', featureFlags: { newCheckout: true, asyncInvoicing: true }, limits: { maxItemsPerOrder: 100 } });
    expect(fs.existsSync(path.join(staged, 'base.json'))).toBe(false); // inputs are not copied, only the output

    // The template references the bootstrap bucket and the hash-named zip.
    expect(config.asset.s3ObjectKey).toBe(`${config.asset.assetHash}.zip`);
    Template.fromStack(stack); // no CfnOutput here; just prove synthesis of the stack is fine
    const manifest = assembly.getStackByName('Assets');
    const assetManifest = assembly.artifacts.find((a) => a.id === `${manifest.id}.assets`) as cdk.cx_api.AssetManifestArtifact;
    expect(Object.keys(assetManifest.contents.files ?? {})).toContain(config.asset.assetHash);
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  test('the hash changes when the bundled output changes and only then', () => {
    const hashOf = (sourcePath: string) => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'A');
      return new BundledConfigAsset(stack, 'C', { sourcePath }).asset.assetHash;
    };
    const original = path.join(MODULE_DIR, 'assets', 'config');
    expect(hashOf(original)).toBe(hashOf(original));

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm10-config-'));
    fs.copyFileSync(path.join(original, 'base.json'), path.join(tmp, 'base.json'));
    fs.writeFileSync(path.join(tmp, 'overrides.json'), JSON.stringify({ limits: { maxItemsPerOrder: 999 } }));
    expect(hashOf(tmp)).not.toBe(hashOf(original));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('deepMerge merges nested objects and lets overrides win', () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2] })).toEqual({ a: { b: 1, c: 3 }, d: [2] });
  });
});

describe('10 · exercises', () => {
  test('exercise 1: CfnLintIgnoreAspect adds Metadata via addOverride on every matching L1', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    new s3.Bucket(stack, 'A');
    new s3.Bucket(stack, 'B');
    cdk.Aspects.of(stack).add(new CfnLintIgnoreAspect({ ignoreByType: { 'AWS::S3::Bucket': ['W3045', 'E3012'] } }), { priority: cdk.AspectPriority.MUTATING });
    const template = Template.fromStack(stack);
    const buckets = template.findResources('AWS::S3::Bucket');
    expect(Object.keys(buckets)).toHaveLength(2);
    for (const b of Object.values(buckets)) expect(b.Metadata).toEqual({ 'cfn-lint': { config: { ignore_checks: ['W3045', 'E3012'] } } });
  });

  test('exercise 2: ParameterReader reads via GetParameter and exposes the value as Fn::GetAtt', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    const reader = new ParameterReader(stack, 'R', { parameterName: '/shared/db/host', version: 3 });
    new cdk.CfnOutput(stack, 'Host', { value: reader.value });
    const template = Template.fromStack(stack);
    const [res] = Object.values(template.findResources('Custom::SsmParameterReader'));
    expect(renderJoin(res.Properties.Create)).toContain('"action":"GetParameter"');
    expect(res.Properties.Delete).toBeUndefined();
    expect(res.Properties.Version).toBe(3);
    template.hasOutput('Host', { Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^R'), 'Parameter.Value'] } });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: [Match.objectLike({ Action: 'ssm:GetParameter', Resource: Match.objectLike({ 'Fn::Join': Match.anyValue() }) })] },
    });
  });

  test('exercise 3: S3ObjectWriter grants PutObject/DeleteObject on exactly one key', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    const bucket = new s3.Bucket(stack, 'Site');
    const writer = new S3ObjectWriter(stack, 'Robots', { bucket, key: 'robots.txt', body: 'User-agent: *\nDisallow: /admin\n' });
    new cdk.CfnOutput(stack, 'Url', { value: writer.url });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('Custom::S3ObjectWriter', {
      Bucket: { Ref: Match.stringLikeRegexp('^Site') },
      Key: 'robots.txt',
      Body: Match.stringLikeRegexp('Disallow'),
      ServiceTimeout: '120', // rendered as a string by CustomResource
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Sid: 'WriteExactlyThisObject',
            Action: ['s3:PutObject', 's3:DeleteObject'],
            Effect: 'Allow',
            Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [Match.stringLikeRegexp('^Site'), 'Arn'] }, '/robots.txt']] },
          },
        ],
      },
    });
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 's3-object-writer.handler' });
    template.resourcePropertiesCountIs('AWS::Lambda::Function', { Handler: 'framework.isComplete' }, 0); // onEvent only: no waiter
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 0);
    template.hasOutput('Url', { Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Robots'), 'Url'] } });
  });
});
