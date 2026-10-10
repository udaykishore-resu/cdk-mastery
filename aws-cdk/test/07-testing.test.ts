/**
 * Module 07 — this file *is* the module. Every describe block maps to a section
 * of the README; read them side by side.
 */
import * as cdk from 'aws-cdk-lib';
import { Annotations, Capture, Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import {
  EncryptedQueuesAspect,
  TestableStack,
  TestableStage,
  stableSynthesizer,
  stabilizeAssets,
} from '../src/modules/07-testing';
import { expectNoWildcardIam, findWildcardIam } from '../src/modules/07-testing/solutions/exercise-1-no-wildcard-iam';
import { PreviewStage } from '../src/modules/07-testing/solutions/exercise-2-preview-stage';
import { diffTemplates, expectStableLogicalIds } from '../src/modules/07-testing/solutions/exercise-3-template-diff';

/**
 * One synthesized template per tier, shared across tests. Synthesis is the slow
 * part (asset staging + rendering); assertions are microseconds. Build once in a
 * `beforeAll`, never mutate the stack afterwards.
 */
function synth(tier = ENVIRONMENTS.dev, extra: { enableDlq?: boolean; reservedConcurrency?: number } = {}) {
  const app = new cdk.App();
  const stack = new TestableStack(app, 'Testable', { tier, ...extra });
  return { app, stack, template: Template.fromStack(stack) };
}

describe('07 · fine-grained assertions', () => {
  let dev: Template;
  let prod: Template;
  beforeAll(() => {
    dev = synth(ENVIRONMENTS.dev).template;
    prod = synth(ENVIRONMENTS.prod).template;
  });

  test('hasResourceProperties does a partial (objectLike) match on Properties', () => {
    dev.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      MemorySize: 256,
      Timeout: 15,
      // Environment is nested; objectLike is applied at every level of the pattern.
      Environment: { Variables: { TABLE_NAME: { Ref: Match.stringLikeRegexp('^Orders') } } },
    });
  });

  test('hasResource reaches outside Properties: DeletionPolicy follows the tier', () => {
    // hasResource matches the whole resource object; DeletionPolicy/UpdateReplacePolicy live beside Properties.
    prod.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    dev.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
    prod.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain' });
  });

  test('resourceCountIs counts by type; resourcePropertiesCountIs counts by type + properties', () => {
    dev.resourceCountIs('AWS::SQS::Queue', 2); // work + dead-letter
    dev.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    dev.resourcePropertiesCountIs('AWS::SQS::Queue', { RedrivePolicy: Match.anyValue() }, 1); // only the work queue has one
    dev.resourcePropertiesCountIs('AWS::SQS::Queue', { RedrivePolicy: Match.absent() }, 1);
    // Point-in-time recovery is a tier decision: prod on, dev off.
    prod.resourcePropertiesCountIs('AWS::DynamoDB::GlobalTable', { Replicas: Match.arrayWith([Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })]) }, 1);
    dev.resourcePropertiesCountIs('AWS::DynamoDB::GlobalTable', { Replicas: Match.arrayWith([Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false } })]) }, 1);
  });

  test('hasOutput / findOutputs / hasParameter / hasMapping cover the non-resource sections', () => {
    dev.hasOutput('TableName', {
      Value: { Ref: Match.stringLikeRegexp('^Orders') },
      Export: { Name: 'Testable-TableName' },
    });
    const outputs = dev.findOutputs('*');
    expect(Object.keys(outputs).sort()).toEqual(['TableName', 'WorkerArn']);

    dev.hasParameter('AlarmEmail', { Type: 'String', Default: 'platform-team@example.com' });
    dev.hasMapping('RegionConfig', { 'us-east-1': { logBucketPrefix: 'use1' } });
    // The mapping is `lazy`, but findInMap was used, so it is rendered and referenced.
    dev.hasResourceProperties('AWS::S3::Bucket', {
      LoggingConfiguration: { LogFilePrefix: { 'Fn::Join': ['', [{ 'Fn::FindInMap': ['RegionConfig', { Ref: 'AWS::Region' }, 'logBucketPrefix'] }, '/']] } },
    });
  });

  test('templateMatches asserts the whole document (partially, with objectLike semantics)', () => {
    dev.templateMatches({
      Parameters: Match.objectLike({ AlarmEmail: Match.anyValue(), BootstrapVersion: Match.anyValue() }),
      Resources: Match.objectLike({}),
      Outputs: { TableName: Match.anyValue(), WorkerArn: Match.anyValue() }, // exact key set here
    });
  });
});

describe('07 · Match', () => {
  let template: Template;
  beforeAll(() => {
    template = synth().template;
  });

  test('arrayWith is an ordered subsequence; arrayEquals is exact', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      AttributeDefinitions: Match.arrayWith([{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'customerId', AttributeType: 'S' }]),
      KeySchema: Match.arrayEquals([
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ]),
    });
    // Order matters for arrayWith: reversed subsequence does not match.
    expect(() =>
      template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        AttributeDefinitions: Match.arrayWith([{ AttributeName: 'customerId', AttributeType: 'S' }, { AttributeName: 'pk', AttributeType: 'S' }]),
      }),
    ).toThrow(/arrayWith/);
  });

  test('absent, anyValue, not, exact, stringLikeRegexp', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: Match.absent(), // not set → key must not exist
      Handler: Match.stringLikeRegexp('^index\\.'),
      Code: { S3Key: Match.anyValue(), S3Bucket: Match.anyValue() },
      Runtime: Match.not('nodejs18.x'),
    });
    // exact() turns off objectLike at that level: extra keys fail.
    expect(() =>
      template.hasResourceProperties('AWS::SQS::Queue', Match.exact({ VisibilityTimeout: 90 })),
    ).toThrow();
    template.hasResourceProperties('AWS::SQS::Queue', Match.exact({ VisibilityTimeout: 90, RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^DeadLetter'), 'Arn'] }, maxReceiveCount: 3 } }));
  });

  test('a matcher can be used standalone against any value', () => {
    const result = Match.objectLike({ a: Match.anyValue() }).test({ a: 1, b: 2 });
    expect(result.isSuccess).toBe(true);
    expect(Match.exact({ a: 1 }).test({ a: 1, b: 2 }).isSuccess).toBe(false);
  });
});

describe('07 · Capture', () => {
  test('asObject / asArray extract values; next() iterates multiple matches', () => {
    const { template } = synth();

    // Capture the policy document of the worker's default policy and inspect it in code.
    const policyDoc = new Capture();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: policyDoc,
      Roles: [{ Ref: Match.stringLikeRegexp('^WorkerServiceRole') }],
    });
    const statements = policyDoc.asObject().Statement as Array<{ Action: string | string[]; Resource: unknown }>;
    const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions).toEqual(expect.arrayContaining(['sqs:ReceiveMessage', 'dynamodb:PutItem', 's3:GetObject*']));
    expect(actions).not.toContain('*');

    // Two queues → two matches. `next()` advances; returns false when exhausted.
    const logicalIds = new Capture();
    template.hasResource('AWS::SQS::Queue', { Properties: Match.anyValue(), DeletionPolicy: logicalIds });
    const seen = [logicalIds.asString()];
    while (logicalIds.next()) seen.push(logicalIds.asString());
    expect(seen).toEqual(['Delete', 'Delete']);

    // Capture with an inner pattern only captures values that match it.
    const redrive = new Capture(Match.objectLike({ maxReceiveCount: 3 }));
    template.hasResourceProperties('AWS::SQS::Queue', { RedrivePolicy: redrive });
    expect(redrive.asObject().maxReceiveCount).toBe(3);
    expect(redrive.next()).toBe(false); // the DLQ has no RedrivePolicy → exactly one capture
  });

  test('findResources returns the raw matches for ad-hoc inspection', () => {
    const { template } = synth();
    const queues = template.findResources('AWS::SQS::Queue', { Properties: { RedrivePolicy: Match.anyValue() } });
    expect(Object.keys(queues)).toHaveLength(1);
    expect(Object.keys(queues)[0]).toMatch(/^Work/);
    const asArray = Object.entries(queues).map(([id, r]) => ({ id, timeout: r.Properties.VisibilityTimeout }));
    expect(asArray[0].timeout).toBe(90);
  });
});

describe('07 · Annotations (aspects, warnings, negative tests)', () => {
  test('a read-only aspect reports through Annotations, which tests read per construct path', () => {
    const { stack } = synth();
    cdk.Aspects.of(stack).add(new EncryptedQueuesAspect(), { priority: cdk.AspectPriority.READONLY });
    const annotations = Annotations.fromStack(stack);
    annotations.hasError('/Testable/Work/Resource', Match.stringLikeRegexp('EncryptedQueuesAspect'));
    annotations.hasError('/Testable/DeadLetter/Resource', Match.stringLikeRegexp('EncryptedQueuesAspect'));
    expect(annotations.findError('*', Match.stringLikeRegexp('EncryptedQueuesAspect'))).toHaveLength(2);
  });

  test('testing an aspect in isolation: a throwaway Stack with one construct', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Isolated');
    new sqs.Queue(stack, 'Encrypted', { encryption: sqs.QueueEncryption.SQS_MANAGED });
    new sqs.Queue(stack, 'Implicit');
    cdk.Aspects.of(stack).add(new EncryptedQueuesAspect());
    const annotations = Annotations.fromStack(stack);
    annotations.hasNoError('/Isolated/Encrypted/Resource', Match.anyValue());
    annotations.hasError('/Isolated/Implicit/Resource', Match.anyValue());
  });

  test('negative test: enableDlq=false removes the DLQ and records a warning', () => {
    const { stack, template } = synth(ENVIRONMENTS.dev, { enableDlq: false });
    template.resourceCountIs('AWS::SQS::Queue', 1);
    template.hasResourceProperties('AWS::SQS::Queue', { RedrivePolicy: Match.absent() });
    Annotations.fromStack(stack).hasWarning('/Testable', Match.stringLikeRegexp('no dead-letter queue'));
    // and the default configuration has no warnings at all
    Annotations.fromStack(synth().stack).hasNoWarning('*', Match.anyValue());
  });

  test('negative test: an optional prop is absent unless asked for', () => {
    synth().template.hasResourceProperties('AWS::Lambda::Function', { ReservedConcurrentExecutions: Match.absent() });
    synth(ENVIRONMENTS.dev, { reservedConcurrency: 5 }).template.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 5,
    });
  });
});

describe('07 · snapshots, honestly', () => {
  test('a raw snapshot is hostage to asset hashes and bootstrap plumbing', () => {
    const { template } = synth();
    const json = template.toJSON();
    const fn = Object.values(json.Resources as Record<string, { Type: string; Properties: { Code?: { S3Key?: string } } }>).find((r) => r.Type === 'AWS::Lambda::Function' && r.Properties.Code?.S3Key);
    expect(fn?.Properties.Code?.S3Key).toMatch(/^[0-9a-f]{64}\.zip$/); // changes whenever handlers/ changes
    expect(json.Parameters.BootstrapVersion).toBeDefined(); // changes when bootstrap version bumps
    expect(json.Rules.CheckBootstrapVersion).toBeDefined();
  });

  test('stabilised snapshot: hashes masked, bootstrap rule removed', () => {
    const app = new cdk.App();
    const stack = new TestableStack(app, 'Snap', { tier: ENVIRONMENTS.prod, synthesizer: stableSynthesizer() });
    const json = stabilizeAssets(Template.fromStack(stack).toJSON());
    expect(json.Parameters?.BootstrapVersion).toBeUndefined();
    expect(json.Rules).toBeUndefined();
    expect(JSON.stringify(json)).not.toMatch(/[0-9a-f]{64}/);
    expect(json).toMatchSnapshot();
  });

  test('asserting structure instead of content for asset-backed resources', () => {
    synth().template.hasResourceProperties('AWS::Lambda::Function', {
      Code: {
        S3Bucket: { 'Fn::Sub': 'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}' },
        S3Key: Match.stringLikeRegexp('^[0-9a-f]{64}\\.zip$'),
      },
    });
  });
});

describe('07 · testing a Stage through the cloud assembly', () => {
  test('app.synth() exposes stacks, names, envs and dependencies of a Stage', () => {
    const app = new cdk.App();
    const stage = new TestableStage(app, 'Dev', { tier: ENVIRONMENTS.dev, env: { account: '111111111111', region: 'us-east-1' } });
    const assembly = app.synth().getNestedAssembly(stage.artifactId);

    const names = assembly.stacks.map((s) => s.stackName).sort();
    expect(names).toEqual(['Dev-Config', 'Dev-Workload']); // Stage id is prefixed onto stack names
    expect(assembly.stacks.map((s) => s.hierarchicalId).sort()).toEqual(['Dev/Config', 'Dev/Workload']);

    const workload = assembly.getStackByName('Dev-Workload');
    expect(workload.environment).toEqual(expect.objectContaining({ account: '111111111111', region: 'us-east-1' }));
    expect(Object.keys(workload.template.Resources)).toEqual(expect.arrayContaining([expect.stringMatching(/^Orders/)]));

    // Config consumes Workload's table name, so it depends on Workload. Every stack also
    // depends on its own asset-manifest artifact (`<id>.assets`) — that is what the CLI
    // publishes with cdk-assets before deploying the stack.
    const config = assembly.getStackByName('Dev-Config');
    expect(config.dependencies.map((d) => d.id)).toEqual(expect.arrayContaining([workload.id, `${config.id}.assets`]));
    const workloadAssets = assembly.artifacts.find((a) => a.id === `${workload.id}.assets`) as cdk.cx_api.AssetManifestArtifact;
    expect(Object.keys(workloadAssets.contents.files ?? {}).length).toBeGreaterThanOrEqual(2); // template + Lambda code
  });

  test('Template.fromStack still works on a stack inside a Stage', () => {
    const app = new cdk.App();
    const stage = new TestableStage(app, 'Dev', { tier: ENVIRONMENTS.dev });
    Template.fromStack(stage.workload).resourceCountIs('AWS::Lambda::Function', 2); // worker + autoDeleteObjects provider
    Template.fromStack(stage.config).hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/cdk-mastery/07/dev/table-name',
      Value: { 'Fn::ImportValue': Match.stringLikeRegexp('^Dev-Workload:ExportsOutput') },
    });
  });
});

describe('07 · exercises', () => {
  test('exercise 1: the worker stack grants no wildcard IAM; a wildcard role is caught', () => {
    expectNoWildcardIam(synth().template);

    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Wild');
    const role = new iam.Role(stack, 'Admin', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    role.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: ['*'] }));
    const template = Template.fromStack(stack);
    expect(findWildcardIam(template)).toEqual([expect.objectContaining({ resourceType: 'AWS::IAM::Policy', reason: 'Resource: *' })]);
    expect(() => expectNoWildcardIam(template)).toThrow(/Resource: \*/);
  });

  test('exercise 2: PreviewStage names stacks by PR, forces DESTROY, uses the dev tier', () => {
    const app = new cdk.App();
    const stage = new PreviewStage(app, 'Preview42', { prNumber: 42 });
    const assembly = app.synth().getNestedAssembly(stage.artifactId);
    expect(assembly.stacks.map((s) => s.stackName)).toEqual(['pr-42-workload']);

    const template = Template.fromStack(stage.workload);
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    template.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Delete' });
    template.hasResourceProperties('AWS::SQS::Queue', { Tags: Match.arrayWith([{ Key: 'preview', Value: 'pr-42' }]) });
    Annotations.fromStack(stage.workload).hasWarning('/Preview42/Workload', Match.stringLikeRegexp('no dead-letter queue'));
  });

  test('exercise 3: diffTemplates detects a renamed construct as a replacement', () => {
    const before = synth().template.toJSON();

    // Simulate the refactor everyone does once: rename a construct id.
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Testable');
    new s3.Bucket(stack, 'Uploads');
    const app2 = new cdk.App();
    const stack2 = new cdk.Stack(app2, 'Testable');
    new s3.Bucket(stack2, 'UploadBucket');
    const diff = diffTemplates(Template.fromStack(stack).toJSON(), Template.fromStack(stack2).toJSON());
    expect(diff.removed).toEqual([expect.stringMatching(/^Uploads/)]);
    expect(diff.added).toEqual([expect.stringMatching(/^UploadBucket/)]);
    expect(diff.suspectedReplacements).toEqual([expect.objectContaining({ type: 'AWS::S3::Bucket' })]);
    expect(() => expectStableLogicalIds(Template.fromStack(stack).toJSON(), Template.fromStack(stack2).toJSON())).toThrow(/replacement/);

    // A property change on the same logical ID is `changed`, not a replacement.
    const after = synth(ENVIRONMENTS.dev, { reservedConcurrency: 3 }).template.toJSON();
    const propDiff = diffTemplates(before, after);
    expect(propDiff.removed).toEqual([]);
    expect(propDiff.changed).toEqual([expect.stringMatching(/^Worker/)]);
    expectStableLogicalIds(before, after);
  });
});
