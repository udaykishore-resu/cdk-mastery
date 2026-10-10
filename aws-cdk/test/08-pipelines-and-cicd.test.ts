import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Capture, Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pipelines from 'aws-cdk-lib/pipelines';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import { AppStage, GitHubOidcStack, PipelineStack } from '../src/modules/08-pipelines-and-cicd';
import { gatedStageOptions } from '../src/modules/08-pipelines-and-cicd/solutions/exercise-1-permissions-gate';
import { cdkDiffStep } from '../src/modules/08-pipelines-and-cicd/solutions/exercise-2-diff-step';
import { SplitOidcRoles } from '../src/modules/08-pipelines-and-cicd/solutions/exercise-3-split-oidc-roles';

const DEV = { account: '111111111111', region: 'us-east-1' };
const CONNECTION = 'arn:aws:codeconnections:us-east-1:111111111111:connection/11111111-2222-3333-4444-555555555555';

interface PipelineAction {
  Name: string;
  RunOrder: number;
  Namespace?: string;
  ActionTypeId: { Category: string; Provider: string };
  Configuration?: Record<string, unknown>;
  Region?: string;
  RoleArn?: unknown;
}
interface PipelineStage {
  Name: string;
  Actions: PipelineAction[];
}

function pipelineStages(template: Template): PipelineStage[] {
  const [pipeline] = Object.values(template.findResources('AWS::CodePipeline::Pipeline'));
  return pipeline.Properties.Stages as PipelineStage[];
}

function buildPipeline(overrides: Partial<ConstructorParameters<typeof PipelineStack>[2]> = {}) {
  const app = new cdk.App();
  const stack = new PipelineStack(app, 'Pipeline', {
    env: DEV,
    repo: 'revan/cdk-mastery',
    branch: 'main',
    connectionArn: CONNECTION,
    devEnv: DEV,
    prodAccount: '222222222222',
    prodRegions: ['us-west-2', 'eu-west-1'],
    ...overrides,
  });
  return { app, stack, template: Template.fromStack(stack) };
}

describe('08 · self-mutating CodePipeline', () => {
  let template: Template;
  let stages: PipelineStage[];
  let stack: PipelineStack;
  let app: cdk.App;
  beforeAll(() => {
    ({ app, template, stack } = buildPipeline());
    stages = pipelineStages(template);
  });

  test('the pipeline has the canonical stage order: Source, Build, UpdatePipeline, Assets, Dev, Prod', () => {
    expect(stages.map((s) => s.Name)).toEqual(['Source', 'Build', 'UpdatePipeline', 'Assets', 'Dev', 'Prod']);
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'revan-orders-shared-pipeline',
      PipelineType: 'V2', // set explicitly; the cdk.json flag defaultPipelineTypeToV2 is not visible to a bare new App()
    });
  });

  test('source is a CodeConnections action on the configured repo/branch', () => {
    const [source] = stages[0].Actions;
    expect(source.ActionTypeId).toEqual(expect.objectContaining({ Category: 'Source', Provider: 'CodeStarSourceConnection' }));
    expect(source.Configuration).toEqual(expect.objectContaining({ ConnectionArn: CONNECTION, FullRepositoryId: 'revan/cdk-mastery', BranchName: 'main', DetectChanges: true }));
  });

  test('synth runs npm ci && cdk synth with the monorepo output directory, without Docker', () => {
    const buildSpec = new Capture();
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Source: { BuildSpec: buildSpec, Type: 'CODEPIPELINE' },
      Description: 'Pipeline step Pipeline/Pipeline/Build/Synth',
      Environment: Match.objectLike({ PrivilegedMode: false }), // dockerEnabledForSynth: false
    });
    const spec = JSON.parse(buildSpec.asString());
    expect(spec.phases.install.commands).toEqual(['npm ci']); // installCommands → install phase
    expect(spec.phases.build.commands).toEqual(['npx cdk synth --quiet']);
    expect(spec.artifacts['base-directory']).toBe('aws-cdk/cdk.out');
  });

  test('self-mutation: UpdatePipeline deploys the pipeline stack from the fresh assembly', () => {
    const [selfMutate] = stages[2].Actions;
    expect(selfMutate.Name).toBe('SelfMutate');
    const specs = Object.values(template.findResources('AWS::CodeBuild::Project')).map((p) => JSON.parse(p.Properties.Source.BuildSpec as string));
    const mutate = specs.find((s) => JSON.stringify(s).includes('--require-approval=never'));
    expect(mutate).toBeDefined();
    expect(JSON.stringify(mutate.phases.build.commands)).toMatch(/cdk -a \. deploy Pipeline --require-approval=never --verbose/);
  });

  test('assets: the Lambda code asset gets its own publishing action; asset roles are per type', () => {
    expect(stages[3].Actions.map((a) => a.Name)).toEqual(['Consumer_Code']);
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: Match.absent(),
      AssumeRolePolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: 'codebuild.amazonaws.com' } })]) }),
    });
    // The publishing project assumes the *file-publishing* bootstrap role of each target env.
    const specs = Object.values(template.findResources('AWS::CodeBuild::Project')).map((p) => p.Properties.Source.BuildSpec as string);
    expect(specs.some((s) => s.includes('cdk-assets'))).toBe(true);
  });

  test('Dev stage: pre unit tests, Prepare/Deploy per stack in dependency order, post smoke test', () => {
    const dev = stages[4];
    expect(dev.Actions.map((a) => `${a.Name}#${a.RunOrder}`)).toEqual([
      'UnitTests#1',
      'Queue.Prepare#2',
      'Queue.Deploy#3',
      'Function.Prepare#4',
      'Function.Deploy#5',
      'SmokeTest#6',
    ]);
    const prepare = dev.Actions.find((a) => a.Name === 'Queue.Prepare')!;
    expect(prepare.ActionTypeId.Provider).toBe('CloudFormation');
    expect(prepare.Configuration).toEqual(expect.objectContaining({ ActionMode: 'CHANGE_SET_REPLACE', StackName: 'Dev-Queue' }));
    const deploy = dev.Actions.find((a) => a.Name === 'Queue.Deploy')!;
    expect(deploy.Configuration).toEqual(expect.objectContaining({ ActionMode: 'CHANGE_SET_EXECUTE' }));
  });

  test('envFromCfnOutputs wires a stack output into the smoke test through a variable namespace', () => {
    const dev = stages[4];
    const functionDeploy = dev.Actions.find((a) => a.Name === 'Function.Deploy')!;
    expect(functionDeploy.Namespace).toBeDefined();
    const smoke = dev.Actions.find((a) => a.Name === 'SmokeTest')!;
    const envVars = JSON.parse(smoke.Configuration!.EnvironmentVariables as string) as Array<{ name: string; value: string }>;
    expect(envVars).toEqual([{ name: 'FUNCTION_NAME', type: 'PLAINTEXT', value: `#{${functionDeploy.Namespace}.FunctionName}` }]);
  });

  test('Prod wave: one manual approval, then both regions deploy in parallel (same RunOrder)', () => {
    const prod = stages[5];
    expect(prod.Actions[0]).toEqual(expect.objectContaining({ Name: 'PromoteToProd', RunOrder: 1, ActionTypeId: expect.objectContaining({ Category: 'Approval' }) }));
    const byRunOrder = new Map<number, string[]>();
    for (const a of prod.Actions.slice(1)) byRunOrder.set(a.RunOrder, [...(byRunOrder.get(a.RunOrder) ?? []), a.Name]);
    expect(byRunOrder.get(2)?.sort()).toEqual(['ProdEuw1.Queue.Prepare', 'ProdUsw2.Queue.Prepare']);
    expect(byRunOrder.get(5)?.sort()).toEqual(['ProdEuw1.Function.Deploy', 'ProdUsw2.Function.Deploy']);
    // Cross-region + cross-account: actions carry Region and assume the target account's deploy role.
    const usw2 = prod.Actions.find((a) => a.Name === 'ProdUsw2.Queue.Deploy')!;
    expect(usw2.Region).toBe('us-west-2');
    expect(JSON.stringify(usw2.RoleArn)).toMatch(/222222222222:role\/cdk-hnb659fds-deploy-role-222222222222-us-west-2/);
  });

  test('crossAccountKeys follows whether prod is a different account', () => {
    template.resourceCountIs('AWS::KMS::Key', 1); // dev (111…) ≠ prod (222…)
    const sameAccount = buildPipeline({ prodAccount: DEV.account, prodRegions: ['us-east-1'] }).template;
    sameAccount.resourceCountIs('AWS::KMS::Key', 0);
  });

  test('stages inside the pipeline are nested assemblies with the right envs and stack names', () => {
    const assembly = app.synth(); // already synthesized by Template.fromStack; synth() returns the cached assembly
    const dev = assembly.getNestedAssembly(stack.dev.artifactId);
    expect(dev.stacks.map((s) => `${s.stackName}@${s.environment.account}/${s.environment.region}`).sort()).toEqual([
      'Dev-Function@111111111111/us-east-1',
      'Dev-Queue@111111111111/us-east-1',
    ]);
    const prodUsw2 = assembly.getNestedAssembly(stack.prod[0].artifactId);
    expect(prodUsw2.stacks.map((s) => s.environment.region)).toEqual(['us-west-2', 'us-west-2']);
    // Cross-region actions need artifact buckets in each region: the "support" stacks.
    expect(assembly.stacks.map((s) => s.stackName).sort()).toEqual(['Pipeline', 'Pipeline-support-eu-west-1', 'Pipeline-support-us-west-2']);
  });

  test('the AppStage on its own synthesizes two stacks with a cross-stack reference', () => {
    const app = new cdk.App();
    const stage = new AppStage(app, 'Solo', { tier: ENVIRONMENTS.dev, env: DEV });
    Template.fromStack(stage.functionStack).hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      EventSourceArn: { 'Fn::ImportValue': Match.stringLikeRegexp('^Solo-Queue:ExportsOutput') },
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
    Template.fromStack(stage.functionStack).hasOutput('FunctionName', { Value: { Ref: Match.stringLikeRegexp('^Consumer') } });
  });
});

describe('08 · GitHub OIDC', () => {
  function oidc() {
    const app = new cdk.App();
    const stack = new GitHubOidcStack(app, 'Oidc', { env: DEV, repo: 'revan/cdk-mastery', deployBranches: ['main'], deployEnvironments: ['prod'] });
    return { stack, template: Template.fromStack(stack) };
  }

  test('creates a native OIDC provider for GitHub with the STS audience and no pinned thumbprint', () => {
    const { template } = oidc();
    template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
    template.hasResourceProperties('AWS::IAM::OIDCProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIdList: ['sts.amazonaws.com'],
      ThumbprintList: Match.absent(),
    });
    template.resourceCountIs('AWS::Lambda::Function', 0); // no custom-resource provider
  });

  test('the deploy role trusts only tokens for this repo on main or the prod environment', () => {
    const { template } = oidc();
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'github-deploy-revan-cdk-mastery',
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: 'sts:AssumeRoleWithWebIdentity',
            Effect: 'Allow',
            Principal: { Federated: { Ref: Match.stringLikeRegexp('^GitHubProvider') } },
            Condition: {
              StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
              StringLike: {
                'token.actions.githubusercontent.com:sub': ['repo:revan/cdk-mastery:ref:refs/heads/main', 'repo:revan/cdk-mastery:environment:prod'],
              },
            },
          },
        ],
      },
    });
  });

  test('the deploy role may only assume CDK bootstrap roles (tag-conditioned)', () => {
    const { template } = oidc();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Sid: 'AssumeCdkBootstrapRoles',
            Action: 'sts:AssumeRole',
            Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::*:role/cdk-hnb659fds-*-role-*']] },
            Condition: { StringEquals: { 'iam:ResourceTag/aws-cdk:bootstrap-role': ['deploy', 'file-publishing', 'image-publishing', 'lookup'] } },
          }),
        ],
      },
    });
    template.hasOutput('DeployRoleArn', { Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^DeployRole'), 'Arn'] } });
  });

  test('an existing provider can be imported instead of created', () => {
    const app = new cdk.App();
    const stack = new GitHubOidcStack(app, 'Oidc', {
      env: DEV,
      repo: 'revan/cdk-mastery',
      deployBranches: ['main'],
      existingProviderArn: 'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com',
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [Match.objectLike({ Principal: { Federated: 'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com' } })],
      }),
    });
  });

  test('the example workflow file is complete and uses OIDC, diff-on-PR and deploy-on-main', () => {
    const file = path.join(__dirname, '../src/modules/08-pipelines-and-cicd/.github-workflows-example/cdk-deploy.yml');
    const yml = fs.readFileSync(file, 'utf8');
    expect(yml).toMatch(/id-token: write/);
    expect(yml).toMatch(/aws-actions\/configure-aws-credentials@v4/);
    expect(yml).toMatch(/role-to-assume: \$\{\{ vars\.CDK_DEPLOY_ROLE_ARN \}\}/);
    expect(yml).toMatch(/cdk diff --app cdk\.out --all --fail/);
    expect(yml).toMatch(/cdk deploy --app cdk\.out --all --require-approval never/);
    expect(yml).toMatch(/group: cdk-deploy-main\n\s+cancel-in-progress: false/);
    expect(yml).toMatch(/group: cdk-diff-\$\{\{ github\.event\.pull_request\.number \}\}\n\s+cancel-in-progress: true/);
    expect(yml).not.toMatch(/AWS_SECRET_ACCESS_KEY/);
  });
});

describe('08 · exercises', () => {
  test('exercise 1: ConfirmPermissionsBroadening adds a Check + Confirm pair before the stage deploys', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Gated', { env: DEV });
    const pipeline = new pipelines.CodePipeline(stack, 'Pipeline', {
      synth: new pipelines.ShellStep('Synth', {
        input: pipelines.CodePipelineSource.connection('revan/cdk-mastery', 'main', { connectionArn: CONNECTION }),
        commands: ['npm ci', 'npx cdk synth'],
        primaryOutputDirectory: 'aws-cdk/cdk.out',
      }),
    });
    const stage = new AppStage(stack, 'Prod', { tier: ENVIRONMENTS.prod, env: DEV });
    pipeline.addStage(stage, gatedStageOptions(stage));
    const prod = pipelineStages(Template.fromStack(stack)).find((s) => s.Name === 'Prod')!;
    expect(prod.Actions.slice(0, 2).map((a) => `${a.Name}#${a.RunOrder}`)).toEqual(['SecurityCheck.Check#1', 'SecurityCheck.Confirm#2']);
    expect(prod.Actions[1].ActionTypeId.Category).toBe('Approval');
    expect(prod.Actions[2].Name).toBe('Queue.Prepare');
    // The check project runs cdk diff --security-only against the stage's stacks.
    // The check project's buildspec contains tokens (an Fn::Join), so stringify the whole thing.
    const specs = Object.values(Template.fromStack(stack).findResources('AWS::CodeBuild::Project')).map((p) => JSON.stringify(p.Properties.Source.BuildSpec));
    expect(specs.some((s) => s.includes('--security-only --fail'))).toBe(true);
  });

  test('exercise 2: a cdk diff CodeBuildStep can assume the lookup/deploy bootstrap roles', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Diffed', { env: DEV });
    const pipeline = new pipelines.CodePipeline(stack, 'Pipeline', {
      synth: new pipelines.ShellStep('Synth', {
        input: pipelines.CodePipelineSource.connection('revan/cdk-mastery', 'main', { connectionArn: CONNECTION }),
        commands: ['npm ci', 'npx cdk synth'],
        primaryOutputDirectory: 'aws-cdk/cdk.out',
      }),
    });
    const stage = new AppStage(stack, 'Dev', { tier: ENVIRONMENTS.dev, env: DEV });
    pipeline.addStage(stage, { pre: [cdkDiffStep({ stage, failOnDiff: true })] });
    const template = Template.fromStack(stack);
    const dev = pipelineStages(template).find((s) => s.Name === 'Dev')!;
    expect(dev.Actions[0].Name).toBe('Diff');
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      // The stage's construct path includes the pipeline stack ("Diffed/Dev"); that is also its hierarchical id in cdk.out.
      Source: { BuildSpec: Match.stringLikeRegexp("cdk diff --app \\. 'Diffed/Dev/\\*\\*' --fail") },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AssumeLookupAndDeployRoles',
            Condition: { StringEquals: { 'iam:ResourceTag/aws-cdk:bootstrap-role': ['lookup', 'deploy'] } },
          }),
        ]),
      },
    });
  });

  test('exercise 3: split roles — PRs get a diff role, main/prod get the deploy role', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Split', { env: DEV });
    const provider = iam.OidcProviderNative.fromOidcProviderArn(stack, 'P', 'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com');
    new SplitOidcRoles(stack, 'Roles', { repo: 'revan/cdk-mastery', provider });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::IAM::Role', 2);
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'github-diff-revan-cdk-mastery',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [Match.objectLike({ Condition: Match.objectLike({ StringLike: { 'token.actions.githubusercontent.com:sub': ['repo:revan/cdk-mastery:pull_request'] } }) })],
      }),
    });
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'github-deploy-revan-cdk-mastery',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: { 'token.actions.githubusercontent.com:sub': ['repo:revan/cdk-mastery:ref:refs/heads/main', 'repo:revan/cdk-mastery:environment:prod'] },
            }),
          }),
        ],
      }),
    });
    // Diff role: lookup + deploy only; deploy role: all four.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: [Match.objectLike({ Sid: 'AssumeReadBootstrapRoles', Condition: { StringEquals: { 'iam:ResourceTag/aws-cdk:bootstrap-role': ['lookup', 'deploy'] } } })] },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: [Match.objectLike({ Sid: 'AssumeAllBootstrapRoles' })] },
    });
  });
});
