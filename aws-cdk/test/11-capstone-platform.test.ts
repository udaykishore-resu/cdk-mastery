import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import {
  OrdersPlatformStage,
  PLATFORM_TARGETS,
  PipelineStack,
  PIPELINE_ENV,
  addToApp,
  sizingFor,
} from '../src/modules/11-capstone-platform';
import { STAGING_TARGET, approvalStepsFor } from '../src/modules/11-capstone-platform/solutions/exercise-1-staging-target';
import { CostModel, estimateMonthlyCost } from '../src/modules/11-capstone-platform/solutions/exercise-2-cost-model';
import { MultiRegionOrdersPlatform } from '../src/modules/11-capstone-platform/solutions/exercise-3-active-passive-region';

const context = (require('../cdk.json') as { context: Record<string, unknown> }).context;

/** A fresh App per test: synthesis is one-shot and governance plugins run at synth time. */
function newApp(): cdk.App {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'm11-'));
  return new cdk.App({ outdir, context });
}

function stageFor(app: cdk.App, tier: 'dev' | 'prod', id = `M11-${tier[0].toUpperCase()}${tier.slice(1)}`): OrdersPlatformStage {
  const target = PLATFORM_TARGETS[tier];
  return new OrdersPlatformStage(app, id, { tier: target.tier, env: target.env });
}

describe('OrdersPlatformStage — shape', () => {
  it('builds five stacks whose names read like the architecture', () => {
    const stage = stageFor(newApp(), 'dev');
    const names = [stage.network, stage.data, stage.api, stage.worker, stage.observability].map((s) => s.stackName);
    expect(names).toEqual([
      'revan-orders-dev-network-use1',
      'revan-orders-dev-data-use1',
      'revan-orders-dev-api-use1',
      'revan-orders-dev-worker-use1',
      'revan-orders-dev-observability-use1',
    ]);
  });

  it('derives the deploy order from references: Network and Data before Api, Api before Worker, Worker before Observability', () => {
    // Cross-stack references are resolved during synthesis (the "prepare" phase),
    // so stack dependencies are only visible on the synthesized assembly, not on
    // the constructs. That is also why `cdk deploy` needs a full synth to order stacks.
    const app = newApp();
    const stage = stageFor(app, 'dev');
    const assembly = app.synth().getNestedAssembly(stage.artifactId);
    // Every stack also depends on its own `.assets` artifact (asset publishing precedes deployment); ignore those.
    const deps = (s: cdk.Stack) => assembly.getStackArtifact(s.artifactId).dependencies.map((d) => d.id).filter((id) => !id.endsWith('.assets'));
    expect(deps(stage.api)).toEqual(expect.arrayContaining([stage.data.artifactId]));
    expect(deps(stage.worker)).toEqual(expect.arrayContaining([stage.network.artifactId, stage.api.artifactId, stage.data.artifactId]));
    expect(deps(stage.observability)).toEqual(expect.arrayContaining([stage.api.artifactId, stage.worker.artifactId, stage.data.artifactId]));
    expect(deps(stage.network)).toEqual([]);
    expect(deps(stage.data)).toEqual([]);
  });

  it('references the table by name, not by export, so IAM statements are not coupled to Data stack outputs', () => {
    const stage = stageFor(newApp(), 'dev');
    const api = Template.fromStack(stage.api).toJSON() as { Resources: Record<string, { Type: string; Properties?: unknown }> };
    const policies = Object.values(api.Resources).filter((r) => r.Type === 'AWS::IAM::Policy');
    expect(policies.length).toBeGreaterThan(0);
    const statements = policies.flatMap((p) => (p.Properties as { PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> } }).PolicyDocument.Statement);
    const dynamo = statements.filter((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]).some((a) => a.startsWith('dynamodb:')));
    expect(dynamo).toHaveLength(1);
    // A literal ARN rebuilt from the deterministic name — no Export/Import, no GetStackOutput.
    expect(dynamo[0].Resource).toBe('arn:aws:dynamodb:us-east-1:111111111111:table/revan-orders-dev-orders');
    // The KMS key *is* passed as a construct reference on purpose: it is what keeps Data → Api in deploy order.
    // With `@aws-cdk/core:defaultCrossStackReferences: "weak"` (cdk.json) it renders as Fn::GetStackOutput.
    const kms = statements.find((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]).some((a) => a.startsWith('kms:')))!;
    expect(kms.Resource).toEqual({ 'Fn::GetStackOutput': expect.objectContaining({ StackName: 'revan-orders-dev-data-use1', Region: 'us-east-1' }) });
  });
});

describe('OrdersPlatformStage — tier-driven decisions', () => {
  it('dev destroys stateful resources; prod retains them and enables PITR + deletion protection', () => {
    const dev = Template.fromStack(stageFor(newApp(), 'dev').data);
    dev.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
    dev.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      Replicas: [Match.objectLike({ DeletionProtectionEnabled: false, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false } })],
    });
    dev.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Delete' });

    const prod = Template.fromStack(stageFor(newApp(), 'prod').data);
    prod.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    prod.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      Replicas: [Match.objectLike({ DeletionProtectionEnabled: true, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
    });
    prod.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
    prod.hasResourceProperties('AWS::KMS::Key', { PendingWindowInDays: 30, EnableKeyRotation: true });
  });

  it('prod buys one NAT gateway per AZ; dev buys one in total', () => {
    Template.fromStack(stageFor(newApp(), 'dev').network).resourceCountIs('AWS::EC2::NatGateway', 1);
    Template.fromStack(stageFor(newApp(), 'prod').network).resourceCountIs('AWS::EC2::NatGateway', 3);
    expect(sizingFor(ENVIRONMENTS.dev).natGateways).toBe(1);
    expect(sizingFor(ENVIRONMENTS.prod).natGateways).toBe(3);
  });

  it('prod protects the table with reserved worker concurrency and every stack with termination protection', () => {
    const prod = stageFor(newApp(), 'prod');
    Template.fromStack(prod.worker).hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'worker.handler',
      ReservedConcurrentExecutions: 50,
    });
    for (const stack of [prod.network, prod.data, prod.api, prod.worker, prod.observability]) expect(stack.terminationProtection).toBe(true);

    const dev = stageFor(newApp(), 'dev');
    Template.fromStack(dev.worker).hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'worker.handler',
      ReservedConcurrentExecutions: Match.absent(),
    });
    expect(dev.data.terminationProtection).toBeFalsy();
  });

  it('log retention follows the tier (7 days dev, 365 prod)', () => {
    Template.fromStack(stageFor(newApp(), 'dev').api).hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
    Template.fromStack(stageFor(newApp(), 'prod').api).hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 365 });
  });

  it('API throttling is tier-sized and access logging is on the explicit $default stage', () => {
    const t = Template.fromStack(stageFor(newApp(), 'prod').api);
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: Match.objectLike({ ThrottlingRateLimit: 1000, ThrottlingBurstLimit: 2000, DetailedMetricsEnabled: true }),
      AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }),
    });
  });
});

describe('OrdersPlatformStage — security posture', () => {
  it('only /health is unauthenticated; data routes use the IAM authorizer', () => {
    const t = Template.fromStack(stageFor(newApp(), 'dev').api);
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'GET /health', AuthorizationType: 'NONE' });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /orders', AuthorizationType: 'AWS_IAM' });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'GET /orders/{id}', AuthorizationType: 'AWS_IAM' });
    t.resourcePropertiesCountIs('AWS::ApiGatewayV2::Route', { AuthorizationType: 'NONE' }, 1);
  });

  it('queues are KMS-encrypted with the platform key, enforce SSL, and the work queue dead-letters after 5 receives', () => {
    const t = Template.fromStack(stageFor(newApp(), 'dev').worker);
    t.resourceCountIs('AWS::SQS::Queue', 2);
    t.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'revan-orders-dev-orders-work',
      KmsMasterKeyId: Match.anyValue(),
      VisibilityTimeout: 180,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
    t.resourcePropertiesCountIs('AWS::SQS::QueuePolicy', { PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({ Condition: { Bool: { 'aws:SecureTransport': 'false' } }, Effect: 'Deny' })]) }) }, 2);
  });

  it('the worker runs in private subnets with an egress-only security group', () => {
    const stage = stageFor(newApp(), 'dev');
    Template.fromStack(stage.network).hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupEgress: [Match.objectLike({ CidrIp: '0.0.0.0/0', FromPort: 443, ToPort: 443, IpProtocol: 'tcp' })],
      SecurityGroupIngress: Match.absent(),
    });
    Template.fromStack(stage.worker).hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'worker.handler',
      VpcConfig: Match.objectLike({ SubnetIds: Match.anyValue(), SecurityGroupIds: Match.anyValue() }),
    });
  });

  it('no IAM statement uses Resource:* except the X-Ray one the acknowledgement promises', () => {
    const stage = stageFor(newApp(), 'dev');
    for (const stack of [stage.api, stage.worker]) {
      const policies = Template.fromStack(stack).findResources('AWS::IAM::Policy');
      for (const policy of Object.values(policies)) {
        const statements = (policy.Properties as { PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> } }).PolicyDocument.Statement;
        for (const st of statements) {
          if (st.Resource !== '*') continue;
          const actions = Array.isArray(st.Action) ? st.Action : [st.Action];
          expect(actions.every((a) => a.startsWith('xray:'))).toBe(true);
        }
      }
    }
  });
});

describe('OrdersPlatformStage — observability', () => {
  it('pages on a composite alarm made of the customer-facing signals only', () => {
    const t = Template.fromStack(stageFor(newApp(), 'prod').observability);
    t.resourceCountIs('AWS::CloudWatch::Alarm', 5);
    t.resourceCountIs('AWS::CloudWatch::CompositeAlarm', 1);
    t.hasResourceProperties('AWS::CloudWatch::CompositeAlarm', {
      AlarmActions: [Match.anyValue()],
      OKActions: [Match.anyValue()],
    });
    // AlarmRule is an Fn::Join over alarm ARNs; flatten it and check which alarms participate.
    const [composite] = Object.values(t.findResources('AWS::CloudWatch::CompositeAlarm'));
    const rule = JSON.stringify((composite.Properties as { AlarmRule: unknown }).AlarmRule);
    for (const name of ['Api5xx', 'WorkerErrors', 'DlqNotEmpty']) expect(rule).toContain(name);
    for (const name of ['ApiLatencyP99', 'QueueBacklog']) expect(rule).not.toContain(name);
    expect(rule.match(/ OR /g)).toHaveLength(2);
    t.hasResourceProperties('AWS::SNS::Topic', { KmsMasterKeyId: Match.anyValue() });
    t.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });

  it('prod alarms need three consecutive breaching periods; dev only one', () => {
    Template.fromStack(stageFor(newApp(), 'prod').observability).hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'revan-orders-prod-api-5xx',
      EvaluationPeriods: 3,
    });
    Template.fromStack(stageFor(newApp(), 'dev').observability).hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'revan-orders-dev-api-5xx',
      EvaluationPeriods: 1,
    });
  });
});

describe('Governance at the Stage', () => {
  it('every taggable resource carries the mandatory tags from the shared tier model', () => {
    const stage = stageFor(newApp(), 'prod');
    const expected = [
      { Key: 'cost-center', Value: 'cc-platform-prod' },
      { Key: 'environment', Value: 'prod' },
      { Key: 'managed-by', Value: 'cdk-mastery' },
      { Key: 'owner', Value: 'platform-oncall' },
      { Key: 'service', Value: 'orders' },
    ];
    Template.fromStack(stage.data).hasResourceProperties('AWS::KMS::Key', { Tags: Match.arrayWith(expected) });
    Template.fromStack(stage.network).hasResourceProperties('AWS::EC2::VPC', { Tags: Match.arrayWith(expected) });
    Template.fromStack(stage.worker).hasResourceProperties('AWS::SQS::Queue', { Tags: Match.arrayWith(expected) });
  });

  it('a clean stage synthesizes with cdk-nag AwsSolutions and the house aspects enabled', () => {
    const app = newApp();
    stageFor(app, 'dev');
    stageFor(app, 'prod');
    expect(() => app.synth()).not.toThrow();
  });

  it('a stack that violates the rules fails synthesis with both the nag finding and the house-rule annotation', () => {
    const app = newApp();
    const stage = stageFor(app, 'dev', 'Violating');
    const extra = new cdk.Stack(stage, 'Extra', { env: PLATFORM_TARGETS.dev.env });
    new s3.Bucket(extra, 'Leaky', { blockPublicAccess: undefined });
    new cdk.CfnOutput(extra, 'bad_id', { value: 'x' }); // violates PascalCaseIds

    // The error message *is* the report: one block per finding, then the path of the JSON copy.
    expect(() => app.synth()).toThrow(/AwsSolutions-S1[\s\S]*NoPublicBucketsAspect[\s\S]*validation-report\.json/);
    const report = JSON.parse(fs.readFileSync(path.join(app.outdir, 'validation-report.json'), 'utf8')) as {
      pluginReports: Array<{ pluginName: string; violations: Array<{ ruleName: string; description: string }> }>;
    };
    const violations = report.pluginReports.flatMap((p) => p.violations.map((v) => `${p.pluginName}:${v.ruleName}:${v.description}`));
    expect(violations.some((v) => v.includes('AwsSolutions-S1'))).toBe(true); // access logs missing
    expect(violations.some((v) => v.includes('NoPublicBucketsAspect'))).toBe(true);
    expect(violations.some((v) => v.includes('naming/pascal-case-ids'))).toBe(true);
  });

  it('every acknowledged finding carries a reason', () => {
    const stage = stageFor(newApp(), 'dev');
    const acknowledged = stage.node
      .findAll()
      .flatMap((n) => n.node.metadata.filter((m) => m.type === 'aws:cdk:acknowledged-rules').map((m) => m.data as Record<string, string>))
      .flatMap((d) => Object.entries(d))
      // aws-cdk-lib acknowledges a few of its own cfn-lint findings (CloudFormation-Validate::W…); those are not ours.
      // Ours are recorded under the `Annotation::` namespace because cdk-nag 3 reports through Annotations.
      .filter(([id]) => id.includes('AwsSolutions-'));
    expect(acknowledged.length).toBeGreaterThanOrEqual(7);
    for (const [id, reason] of acknowledged) {
      expect(id).toMatch(/^Annotation::AwsSolutions-/);
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});

describe('PipelineStack', () => {
  const pipelineOf = () => {
    const app = newApp();
    const stack = new PipelineStack(app, 'M11-Pipeline', {
      env: PIPELINE_ENV,
      repo: 'revan/cdk-mastery',
      branch: 'main',
      connectionArn: 'arn:aws:codeconnections:us-east-1:111111111111:connection/00000000-0000-0000-0000-000000000000',
    });
    app.synth();
    return { app, stack, template: Template.fromStack(stack) };
  };

  it('is Source → Synth → SelfMutate → Assets → Dev → Prod, with a manual approval only before prod', () => {
    const { template } = pipelineOf();
    const [pipeline] = Object.values(template.findResources('AWS::CodePipeline::Pipeline'));
    const stages = (pipeline.Properties as { Stages: Array<{ Name: string; Actions: Array<{ Name: string; ActionTypeId: { Category: string } }> }> }).Stages;
    expect(stages.map((s) => s.Name)).toEqual(['Source', 'Build', 'UpdatePipeline', 'Assets', 'M11-Dev', 'M11-Prod']);
    const approvals = (name: string) => stages.find((s) => s.Name === name)!.Actions.filter((a) => a.ActionTypeId.Category === 'Approval');
    expect(approvals('M11-Dev')).toHaveLength(0);
    expect(approvals('M11-Prod')).toHaveLength(1);
    expect(stages.find((s) => s.Name === 'M11-Dev')!.Actions.map((a) => a.Name)).toEqual(expect.arrayContaining(['SmokeTest']));
  });

  it('uses cross-account keys because prod lives in another account, and change sets for deploys', () => {
    const { template } = pipelineOf();
    template.resourceCountIs('AWS::KMS::Key', 1);
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', { PipelineType: 'V2' });
    const [pipeline] = Object.values(template.findResources('AWS::CodePipeline::Pipeline'));
    const prodActions = (pipeline.Properties as { Stages: Array<{ Name: string; Actions: Array<{ Configuration?: { ActionMode?: string } }> }> }).Stages.find((s) => s.Name === 'M11-Prod')!.Actions;
    expect(prodActions.some((a) => a.Configuration?.ActionMode === 'CHANGE_SET_REPLACE')).toBe(true);
    expect(prodActions.some((a) => a.Configuration?.ActionMode === 'CHANGE_SET_EXECUTE')).toBe(true);
  });

  it('the pipeline deploys the same stack names as the workstation stages', () => {
    const { stack } = pipelineOf();
    expect(stack.prod.data.stackName).toBe('revan-orders-prod-data-usw2');
    expect(stack.dev.api.stackName).toBe('revan-orders-dev-api-use1');
  });
});

describe('addToApp', () => {
  it('registers two stages and the pipeline, and the assembly places prod in the prod account', () => {
    const app = newApp();
    addToApp(app);
    const asm = app.synth();
    const all = (a: cdk.cx_api.CloudAssembly): cdk.cx_api.CloudFormationStackArtifact[] => [
      ...a.stacks,
      ...a.nestedAssemblies.flatMap((n) => all(n.nestedAssembly)),
    ];
    const stacks = all(asm);
    const prod = stacks.filter((s) => s.stackName.startsWith('revan-orders-prod-'));
    expect(prod.length).toBe(10); // 5 in M11-Prod + 5 inside the pipeline's copy
    for (const s of prod) expect(`${s.environment.account}/${s.environment.region}`).toBe('222222222222/us-west-2');
    expect(stacks.map((s) => s.stackName)).toEqual(expect.arrayContaining(['M11-Pipeline', 'M11-Pipeline-support-us-west-2']));
  });

  it('snapshot: the Data stack is small enough to review by eye, so its template is pinned', () => {
    const stage = stageFor(newApp(), 'prod');
    expect(Template.fromStack(stage.data).toJSON()).toMatchSnapshot();
  });
});

describe('solutions', () => {
  it('exercise 1: a staging target reuses the stacks unchanged and gets no approval gate', () => {
    const app = newApp();
    const staging = new OrdersPlatformStage(app, 'M11-Staging', { tier: STAGING_TARGET.tier, env: STAGING_TARGET.env });
    Template.fromStack(staging.network).resourceCountIs('AWS::EC2::NatGateway', 3); // HA like prod…
    Template.fromStack(staging.data).hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Delete' }); // …but disposable
    expect(approvalStepsFor(STAGING_TARGET.tier)).toHaveLength(0);
    expect(approvalStepsFor(ENVIRONMENTS.prod)).toHaveLength(1);
    expect(() => app.synth()).not.toThrow();
  });

  it('exercise 2: the cost model attributes the dev/prod delta to NAT gateways and PITR', () => {
    const dev = estimateMonthlyCost(ENVIRONMENTS.dev, { requestsPerMonth: 1_000_000, ordersPerMonth: 100_000, storedGb: 1 });
    const prod = estimateMonthlyCost(ENVIRONMENTS.prod, { requestsPerMonth: 50_000_000, ordersPerMonth: 5_000_000, storedGb: 50 });
    expect(dev.total).toBeLessThan(prod.total);
    expect(dev.lines.find((l) => l.item === 'NAT gateways')!.usd).toBeCloseTo(CostModel.natGatewayHourly * 730, 0);
    expect(prod.lines.find((l) => l.item === 'NAT gateways')!.usd).toBeCloseTo(CostModel.natGatewayHourly * 730 * 3, 0);
    expect(dev.lines.find((l) => l.item === 'DynamoDB PITR')!.usd).toBe(0);
    expect(prod.lines.find((l) => l.item === 'DynamoDB PITR')!.usd).toBeGreaterThan(0);
    expect(prod.fixed).toBeGreaterThan(dev.fixed);
  });

  it('exercise 3: the active/passive layout puts a second prod platform in another region with its own table', () => {
    const app = newApp();
    const mr = new MultiRegionOrdersPlatform(app, 'M11-Global', {
      tier: ENVIRONMENTS.prod,
      account: '222222222222',
      primaryRegion: 'us-west-2',
      secondaryRegion: 'us-east-2',
    });
    expect(mr.primary.data.stackName).toBe('revan-orders-prod-data-usw2');
    expect(mr.secondary.data.stackName).toBe('revan-orders-prod-data-use2');
    expect(mr.secondary.data.region).toBe('us-east-2');
    // Same tier, same shape: the secondary is not a "smaller" copy.
    Template.fromStack(mr.secondary.network).resourceCountIs('AWS::EC2::NatGateway', 3);
    Template.fromStack(mr.healthCheckStack).resourceCountIs('AWS::Route53::HealthCheck', 2);
    Template.fromStack(mr.healthCheckStack).resourceCountIs('AWS::Route53::RecordSet', 2);
    expect(() => app.synth()).not.toThrow();
  });
});
