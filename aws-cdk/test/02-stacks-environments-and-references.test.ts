import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cxapi from 'aws-cdk-lib/cx-api';
import { Construct } from 'constructs';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import {
  addToApp,
  AppStack,
  countResources,
  describeEnvironment,
  DUMMY_ACCOUNT,
  DUMMY_REGION,
  DUMMY_VPC_ID,
  EnvAgnosticStack,
  EnvSpecificStack,
  LookupStack,
  NestedDemoStack,
  PlatformStack,
  platformParameterName,
  ResourceBudget,
  ssmLookupContextKey,
  StatefulStack,
  StatelessStack,
  vpcLookupContextKey,
} from '../src/modules/02-stacks-environments-and-references';
import { HubStack, SpokeStack } from '../src/modules/02-stacks-environments-and-references/solutions/exercise-1-weaken-one-reference';
import { SharedValue, sharedValueName } from '../src/modules/02-stacks-environments-and-references/solutions/exercise-2-shared-value';
import { createShardedQueues } from '../src/modules/02-stacks-environments-and-references/solutions/exercise-3-sharded-stacks';

afterAll(cxapi.CloudAssembly.cleanupTemporaryDirectories);

const dev = ENVIRONMENTS.dev;
const prod = ENVIRONMENTS.prod;
const ENV = { account: DUMMY_ACCOUNT, region: DUMMY_REGION };
const STRONG = { '@aws-cdk/core:defaultCrossStackReferences': 'strong' };
const WEAK = { '@aws-cdk/core:defaultCrossStackReferences': 'weak' };

describe('02 · env-agnostic vs env-specific', () => {
  test('agnostic: account/region are tokens, AZs are Fn::GetAZs selections', () => {
    const stack = new EnvAgnosticStack(new cdk.App(), 'A', { tier: dev });
    const d = describeEnvironment(stack);
    expect(d).toMatchObject({ agnostic: true, account: 'unknown-account', region: 'unknown-region' });
    expect(d.availabilityZones).toHaveLength(2);
    expect(stack.resolve(d.availabilityZones[0])).toEqual({ 'Fn::Select': [0, { 'Fn::GetAZs': '' }] });
    Template.fromStack(stack).hasResourceProperties('AWS::SSM::Parameter', {
      Value: { 'Fn::Join': ['', [{ Ref: 'AWS::AccountId' }, '/', { Ref: 'AWS::Region' }, ' (', { Ref: 'AWS::Partition' }, ')']] },
    });
  });

  test('specific: literals at synth time; region-derived logic works', () => {
    const stack = new EnvSpecificStack(new cdk.App(), 'S', { tier: dev, env: ENV });
    expect(describeEnvironment(stack)).toMatchObject({ agnostic: false, account: DUMMY_ACCOUNT, region: DUMMY_REGION });
    // AZs on a specific stack are a lookup; un-cached → three dummies + a missing-context entry.
    expect(stack.availabilityZones).toEqual(['dummy1a', 'dummy1b', 'dummy1c']);
    Template.fromStack(stack).hasResourceProperties('AWS::SSM::Parameter', {
      Value: Match.stringLikeRegexp('^111111111111/us-east-1 \\(use1\\), 3 AZs known$'),
    });
  });

  test('Aws.REGION is the pseudo-parameter token even in a specific stack', () => {
    const stack = new EnvSpecificStack(new cdk.App(), 'S', { tier: dev, env: ENV });
    expect(stack.resolve(cdk.Aws.REGION)).toEqual({ Ref: 'AWS::Region' });
    expect(stack.region).toBe('us-east-1');
  });
});

describe('02 · stateful / stateless and cross-stack references', () => {
  test('strong: producer Export + consumer Fn::ImportValue, and an implicit stack dependency', () => {
    const app = new cdk.App({ context: STRONG });
    const stateful = new StatefulStack(app, 'M02-Stateful', { tier: dev });
    const stateless = new StatelessStack(app, 'M02-Stateless', { tier: dev, stateful });
    const producer = Template.fromStack(stateful);
    const consumer = Template.fromStack(stateless);

    const outputs = producer.findOutputs('*');
    const exportNames = Object.values(outputs).map((o) => o.Export?.Name);
    expect(exportNames).toEqual(expect.arrayContaining([expect.stringMatching(/^M02-Stateful:ExportsOutputRefOrders[0-9A-F]{8}/), expect.stringMatching(/^M02-Stateful:ExportsOutputFnGetAttOrders[0-9A-F]{8}Arn/)]));
    consumer.hasResourceProperties('AWS::SSM::Parameter', {
      Value: { 'Fn::ImportValue': Match.stringLikeRegexp('^M02-Stateful:ExportsOutputRefOrders') },
    });
    expect(stateless.dependencies).toContain(stateful);
  });

  test('weak (cdk.json default): plain Output on the producer, Fn::GetStackOutput on the consumer, no Export', () => {
    const app = new cdk.App({ context: WEAK });
    const stateful = new StatefulStack(app, 'M02-Stateful', { tier: dev });
    const stateless = new StatelessStack(app, 'M02-Stateless', { tier: dev, stateful });
    const producer = Template.fromStack(stateful);
    const consumer = Template.fromStack(stateless);

    const outputs = Object.values(producer.findOutputs('*'));
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.every((o) => o.Export === undefined)).toBe(true);
    const param = consumer.findResources('AWS::SSM::Parameter');
    const value = JSON.stringify(Object.values(param)[0].Properties.Value);
    expect(value).toContain('Fn::GetStackOutput');
    expect(value).not.toContain('Fn::ImportValue');
  });

  test('the deadly embrace: dropping the consumer usage drops the Export; exportValue keeps it', () => {
    // Step 0 — deployed state: consumer imports two exports (asserted above).
    // Step 1 — naive change: consumer stops using the table → producer template loses the exports.
    const naive = new cdk.App({ context: STRONG });
    const statefulNaive = new StatefulStack(naive, 'M02-Stateful', { tier: dev });
    new StatelessStack(naive, 'M02-Stateless', { tier: dev, stateful: statefulNaive, useTable: false });
    expect(Object.keys(Template.fromStack(statefulNaive).findOutputs('*'))).toHaveLength(0);
    // CloudFormation would now reject the producer update: "Export ... cannot be deleted as it is in use".

    // Step 2 — correct change: keep the exports alive explicitly while the consumer lets go.
    const fixed = new cdk.App({ context: STRONG });
    const statefulFixed = new StatefulStack(fixed, 'M02-Stateful', { tier: dev, retainExports: true });
    new StatelessStack(fixed, 'M02-Stateless', { tier: dev, stateful: statefulFixed, useTable: false });
    const kept = Object.values(Template.fromStack(statefulFixed).findOutputs('*')).map((o) => o.Export?.Name);
    expect(kept).toEqual(expect.arrayContaining([expect.stringMatching(/^M02-Stateful:ExportsOutputRefOrders/), expect.stringMatching(/^M02-Stateful:ExportsOutputFnGetAttOrders[0-9A-F]{8}Arn/)]));
    // Step 3 (not shown): remove `retainExports` and deploy again.
  });

  test('per-resource strength: CrossStackReferences.of(bucket).produce(WEAK) under a strong default', () => {
    const app = new cdk.App({ context: STRONG });
    const stateful = new StatefulStack(app, 'M02-Stateful', { tier: dev, weakBucketReferences: true });
    const stateless = new StatelessStack(app, 'M02-Stateless', { tier: dev, stateful, useBucket: true });
    const consumer = JSON.stringify(Template.fromStack(stateless).toJSON());
    expect(consumer).toContain('Fn::ImportValue'); // the table: strong
    expect(consumer).toContain('Fn::GetStackOutput'); // the bucket: weak
    const exportNames = Object.values(Template.fromStack(stateful).findOutputs('*')).map((o) => o.Export?.Name ?? '(none)');
    expect(exportNames.some((n) => n.includes('Documents'))).toBe(false);
  });

  test('stateful stack protection follows the tier', () => {
    const app = new cdk.App();
    const d = new StatefulStack(app, 'D', { tier: dev });
    const p = new StatefulStack(app, 'P', { tier: prod });
    expect(d.terminationProtection).toBe(false);
    expect(p.terminationProtection).toBe(true);
    Template.fromStack(p).hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    Template.fromStack(d).hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Delete' });
    Template.fromStack(d).resourceCountIs('Custom::S3AutoDeleteObjects', 1);
    Template.fromStack(p).resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });

  test('exercise 1: consumeReference weakens a single usage', () => {
    const app = new cdk.App({ context: STRONG });
    const hub = new HubStack(app, 'Hub');
    const spoke = new SpokeStack(app, 'Spoke', { hub });
    const spokeT = Template.fromStack(spoke);
    spokeT.hasOutput('TopicArn', { Value: { 'Fn::ImportValue': Match.stringLikeRegexp('^Hub:ExportsOutputRefEvents') } });
    const audit = spokeT.findOutputs('AuditQueueArn').AuditQueueArn.Value;
    expect(JSON.stringify(audit)).toContain('Fn::GetStackOutput');
    const hubExports = Object.values(Template.fromStack(hub).findOutputs('*')).map((o) => o.Export?.Name ?? '(none)');
    expect(hubExports.some((n) => n.includes('Audit'))).toBe(false);
  });
});

describe('02 · SSM sharing, Fn.importValue and explicit dependencies', () => {
  test('valueForStringParameter becomes an SSM-typed template parameter', () => {
    const app = new cdk.App();
    const platform = new PlatformStack(app, 'M02-Platform', { tier: dev });
    const appStack = new AppStack(app, 'M02-App', { tier: dev, externalAlertsTopicExportName: 'platform-dev-alerts-topic-arn' });
    appStack.addStackDependency(platform, 'reads platform SSM parameters by name');

    Template.fromStack(platform).hasResourceProperties('AWS::SSM::Parameter', { Name: '/cdk-mastery/dev/platform/deploy-role-arn' });
    const t = Template.fromStack(appStack);
    const params = t.findParameters('*', { Type: 'AWS::SSM::Parameter::Value<String>', Default: platformParameterName(dev, 'deploy-role-arn') });
    expect(Object.keys(params)).toHaveLength(1);
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: [Match.objectLike({ Action: 'sts:AssumeRole', Resource: { Ref: Object.keys(params)[0] } })] },
    });
    t.hasOutput('AlertsTopicArn', { Value: { 'Fn::ImportValue': 'platform-dev-alerts-topic-arn' } });
    // No CDK-visible reference exists, so the dependency had to be declared by hand.
    expect(appStack.dependencies).toContain(platform);
  });

  test('exercise 2: SharedValue naming contract and both consumption modes', () => {
    const parts = { org: 'cdkm', env: 'dev', producer: 'network', key: 'vpc-id' };
    expect(sharedValueName(parts)).toBe('/cdkm/dev/network/vpc-id');

    const app = new cdk.App();
    const producer = new cdk.Stack(app, 'Producer');
    SharedValue.publish(producer, 'VpcId', parts, 'vpc-123');
    Template.fromStack(producer).hasResourceProperties('AWS::SSM::Parameter', { Name: '/cdkm/dev/network/vpc-id', Value: 'vpc-123' });

    const agnostic = new cdk.Stack(app, 'Agnostic');
    expect(cdk.Token.isUnresolved(SharedValue.consumeAtDeploy(agnostic, parts))).toBe(true);
    expect(() => SharedValue.consumeAtSynth(agnostic, parts)).toThrow(/requires a concrete env/);

    const specific = new cdk.Stack(app, 'Specific', { env: ENV });
    specific.node.setContext(ssmLookupContextKey(ENV.account, ENV.region, '/cdkm/dev/network/vpc-id'), 'vpc-cached');
    expect(SharedValue.consumeAtSynth(specific, parts)).toBe('vpc-cached');
  });
});

describe('02 · nested stacks', () => {
  const app = new cdk.App();
  const stack = new NestedDemoStack(app, 'M02-Nested', { tier: dev });
  const parent = Template.fromStack(stack);
  const nested = Template.fromStack(stack.queues);

  test('the parent holds an AWS::CloudFormation::Stack whose template is an asset', () => {
    parent.resourceCountIs('AWS::CloudFormation::Stack', 1);
    parent.hasResourceProperties('AWS::CloudFormation::Stack', {
      TemplateURL: { 'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp('^https://s3\\.')])] },
    });
    expect(stack.queues.nestedStackParent).toBe(stack);
    expect(stack.queues.templateFile).toMatch(/^M02NestedQueues[0-9A-F]{8}\.nested\.template\.json$/);
  });

  test('nested → parent references travel through nested Outputs and Fn::GetAtt Outputs.*', () => {
    nested.resourceCountIs('AWS::SQS::Queue', 2);
    const outputs = nested.findOutputs('*');
    expect(Object.keys(outputs)).toEqual([expect.stringMatching(/^M02NestedQueuesWork[0-9A-F]{8}Arn/)]);
    parent.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: Match.arrayWith(['sqs:ReceiveMessage']),
            Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^QueuesNestedStackQueuesNestedStackResource'), Match.stringLikeRegexp('^Outputs\\.M02NestedQueuesWork')] },
          }),
        ],
      },
    });
  });

  test('a nested stack counts against its own 500, not the parent', () => {
    expect(countResources(stack)).toBe(3); // CloudFormation::Stack + Role + Policy
    expect(countResources(stack.queues)).toBe(4); // 2 queues + 2 queue policies (enforceSSL)
  });
});

describe('02 · context lookups', () => {
  test('seeded context makes Vpc.fromLookup and valueFromLookup synthesize offline with real-looking data', () => {
    const app = new cdk.App();
    const stack = new LookupStack(app, 'M02-Lookup', { tier: dev, env: ENV, vpcId: DUMMY_VPC_ID });
    expect(stack.vpc.vpcId).toBe(DUMMY_VPC_ID);
    expect(stack.vpc.privateSubnets.map((s) => s.subnetId)).toEqual(['subnet-0private0000000a', 'subnet-0private0000000b']);
    expect(stack.vpc.availabilityZones).toEqual(['us-east-1a', 'us-east-1b']);
    expect(stack.logRetentionDays).toBe('30');
    Template.fromStack(stack).hasResourceProperties('AWS::EC2::SecurityGroup', {
      VpcId: DUMMY_VPC_ID,
      GroupDescription: `app sg in ${DUMMY_VPC_ID} (us-east-1a,us-east-1b); logs kept 30 days`,
      SecurityGroupEgress: [Match.objectLike({ CidrIp: '10.0.0.0/16', FromPort: 443 })],
    });
  });

  test('the context key format is exactly what cdk.context.json stores', () => {
    expect(vpcLookupContextKey(DUMMY_ACCOUNT, DUMMY_REGION, DUMMY_VPC_ID)).toBe(
      'vpc-provider:account=111111111111:filter.vpc-id=vpc-0123456789abcdef0:region=us-east-1:returnAsymmetricSubnets=true',
    );
  });

  test('an un-seeded lookup yields a dummy value and a manifest.missing entry the CLI would resolve', () => {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'm02-lookup-'));
    const app = new cdk.App({ outdir });
    const stack = new LookupStack(app, 'M02-Lookup', { tier: dev, env: ENV, vpcId: DUMMY_VPC_ID, seedSsmValue: false });
    expect(stack.logRetentionDays).toBe(`dummy-value-for-${platformParameterName(dev, 'log-retention-days')}`);
    const missing = app.synth().manifest.missing ?? [];
    expect(missing.map((m) => m.key)).toEqual([ssmLookupContextKey(DUMMY_ACCOUNT, DUMMY_REGION, platformParameterName(dev, 'log-retention-days'))]);
    expect(missing[0].provider).toBe('ssm');
    expect(missing[0].props).toMatchObject({ account: DUMMY_ACCOUNT, region: DUMMY_REGION });
    expect((missing[0].props as { lookupRoleArn?: string }).lookupRoleArn).toContain('cdk-hnb659fds-lookup-role-');
  });

  test('lookups refuse env-agnostic stacks', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Agnostic');
    expect(() => ec2.Vpc.fromLookup(stack, 'Vpc', { vpcId: DUMMY_VPC_ID })).toThrow(/Cannot retrieve value from context provider vpc-provider since account\/region are not specified/);
  });
});

describe('02 · the 500-resource budget', () => {
  class Bulk extends cdk.Stack {
    constructor(scope: Construct, id: string, n: number) {
      super(scope, id);
      for (let i = 0; i < n; i++) new sqs.Queue(this, `Q${i}`);
    }
  }

  test('warns at the threshold and errors above the limit', () => {
    const app = new cdk.App();
    const fine = new Bulk(app, 'Fine', 3);
    const warn = new Bulk(app, 'Warn', 8);
    const over = new Bulk(app, 'Over', 11);
    const budget = new ResourceBudget({ limit: 10 }); // warnAt = 8
    for (const s of [fine, warn, over]) cdk.Aspects.of(s).add(budget);

    Annotations.fromStack(fine).hasNoWarning('/Fine', Match.anyValue());
    Annotations.fromStack(warn).hasWarning('/Warn', Match.stringLikeRegexp('8 resources'));
    Annotations.fromStack(over).hasError('/Over', Match.stringLikeRegexp('11 resources; CloudFormation allows 10'));
  });

  test('exercise 3: sharding is positional and append-only', () => {
    const app = new cdk.App();
    const placements = createShardedQueues(app, { idPrefix: 'M02-Tenants', tenants: ['acme', 'globex', undefined, 'initech', 'umbrella'], perStack: 2 });
    expect(placements.map((p) => [p.tenant, p.stackId])).toEqual([
      ['acme', 'M02-TenantsShard0'],
      ['globex', 'M02-TenantsShard0'],
      ['initech', 'M02-TenantsShard1'],
      ['umbrella', 'M02-TenantsShard2'],
    ]);
    // Removing 'globex' (a hole at index 1) must not move 'initech' — its id is positional.
    const initech = placements.find((p) => p.tenant === 'initech')!;
    expect(initech.queue.node.id).toBe('Tenant3');
    Template.fromStack(cdk.Stack.of(initech.queue)).hasResourceProperties('AWS::SQS::Queue', { QueueName: 'm02-tenantsshard1-initech' });
    expect(() => createShardedQueues(app, { idPrefix: 'X', tenants: ['a'], perStack: 0 })).toThrow(/perStack/);
  });
});

describe('02 · addToApp', () => {
  test('registers the documented stacks with the right envs and dependencies', () => {
    const app = new cdk.App({ context: WEAK });
    addToApp(app);
    const stacks = app.node.children.filter((c): c is cdk.Stack => cdk.Stack.isStack(c));
    const byName = Object.fromEntries(stacks.map((s) => [s.stackName, s]));
    expect(Object.keys(byName).sort()).toEqual(['M02-Agnostic', 'M02-App', 'M02-Lookup', 'M02-Nested', 'M02-Platform', 'M02-Specific', 'M02-Stateful', 'M02-Stateless']);
    expect(describeEnvironment(byName['M02-Agnostic']).agnostic).toBe(true);
    expect(describeEnvironment(byName['M02-Specific'])).toMatchObject({ account: '111111111111', region: 'us-east-1' });
    expect(describeEnvironment(byName['M02-Lookup']).agnostic).toBe(false);
    expect(byName['M02-App'].dependencies).toContain(byName['M02-Platform']);
    // Implicit (reference-driven) dependencies are only recorded during synthesis.
    Template.fromStack(byName['M02-Stateless']);
    expect(byName['M02-Stateless'].dependencies).toContain(byName['M02-Stateful']);
    // every M02 stack carries the budget aspect
    for (const s of stacks) expect(cdk.Aspects.of(s).all.some((a) => a instanceof ResourceBudget)).toBe(true);
  });
});
