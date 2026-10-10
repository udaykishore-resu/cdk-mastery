import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cxapi from 'aws-cdk-lib/cx-api';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import {
  DeploymentTarget,
  FLAGS_WE_DEPEND_ON,
  GlobalStack,
  PlatformStage,
  RegionalStack,
  TARGETS,
  envUri,
  flagValue,
  missingRecommendedFlags,
  platformSynthesizer,
  qualifierFor,
  targetFor,
} from '../src/modules/09-multi-account-and-multi-region';
import { validateTargets } from '../src/modules/09-multi-account-and-multi-region/solutions/exercise-1-validate-targets';
import { RegionConfig } from '../src/modules/09-multi-account-and-multi-region/solutions/exercise-2-region-config';
import { MultiRegionStage } from '../src/modules/09-multi-account-and-multi-region/solutions/exercise-3-multi-region-stage';

/** Same shape as bin/app.ts: two stages from one table. `app.synth()` is legitimate here — we test the assembly. */
function synthPlatform(context: Record<string, unknown> = {}) {
  const app = new cdk.App({ context });
  const dev = new PlatformStage(app, 'M09-Dev', { target: targetFor('dev', app) });
  const prod = new PlatformStage(app, 'M09-Prod', { target: targetFor('prod', app) });
  const assembly = app.synth();
  return { app, dev, prod, assembly };
}

describe('09 · Stage × Environment lands stacks in the right account/region', () => {
  test('the manifest of each nested assembly records aws://<account>/<region> per stack', () => {
    const { dev, prod, assembly } = synthPlatform();

    const devAsm = assembly.getNestedAssembly(dev.artifactId);
    expect(devAsm.stacks.map((s) => [s.stackName, envUri(s.environment as Required<cdk.Environment>)])).toEqual([
      ['revan-platform-dev-regional-use1', 'aws://111111111111/us-east-1'],
    ]);

    const prodAsm = assembly.getNestedAssembly(prod.artifactId);
    const byName = Object.fromEntries(prodAsm.stacks.map((s) => [s.stackName, s]));
    expect(Object.keys(byName).sort()).toEqual(['revan-platform-prod-global-use1', 'revan-platform-prod-regional-usw2']);
    expect(byName['revan-platform-prod-global-use1'].environment).toEqual({ account: '222222222222', region: 'us-east-1', name: 'aws://222222222222/us-east-1' });
    expect(byName['revan-platform-prod-regional-usw2'].environment).toEqual({ account: '222222222222', region: 'us-west-2', name: 'aws://222222222222/us-west-2' });

    // The raw manifest says the same thing (this is what the CLI reads).
    const artifact = prodAsm.manifest.artifacts![byName['revan-platform-prod-regional-usw2'].id];
    expect(artifact.environment).toBe('aws://222222222222/us-west-2');
    // Hierarchical ids keep the construct path; stack names are ours.
    expect(byName['revan-platform-prod-regional-usw2'].hierarchicalId).toBe('M09-Prod/Regional');
  });

  test('dev has no global stack; prod has one, and it depends nothing on the regional stack', () => {
    const { dev, prod } = synthPlatform();
    expect(dev.global).toBeUndefined();
    expect(prod.global).toBeDefined();
    expect(prod.regional.dependencies.map((d) => d.node.id)).toEqual(['Global']); // consumer depends on producer
  });

  test('context overrides the account/region of a tier without code changes', () => {
    const { prod, assembly } = synthPlatform({ 'cdk-mastery:prod-account': '333333333333' });
    const prodAsm = assembly.getNestedAssembly(prod.artifactId);
    expect(prodAsm.stacks.every((s) => s.environment.account === '333333333333')).toBe(true);
    expect(targetFor('prod').env.account).toBe('222222222222'); // the static table is untouched
  });

  test('Stack.of(this).account assertion refuses a mismatched concrete env, ignores tokens', () => {
    const app = new cdk.App();
    expect(
      () => new RegionalStack(app, 'Wrong', { target: TARGETS.prod, env: { account: '111111111111', region: 'us-west-2' } }),
    ).toThrow(/must deploy to account 222222222222, got 111111111111/);
    expect(() => new RegionalStack(app, 'WrongRegion', { target: TARGETS.prod, env: { account: '222222222222', region: 'us-east-1' } })).toThrow(/region/);
    // Env-agnostic: account is a token, so the guard must not fire.
    expect(() => new RegionalStack(app, 'Agnostic', { target: TARGETS.dev })).not.toThrow();
    expect(cdk.Token.isUnresolved(cdk.Stack.of(app.node.findChild('Agnostic')).account)).toBe(true);
  });

  test('Aws.ACCOUNT_ID / Aws.REGION become pseudo-parameter Refs; the account never appears literally', () => {
    const { prod } = synthPlatform();
    const template = Template.fromStack(prod.regional);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: { 'Fn::Join': ['', ['revan-platform-prod-data-', { Ref: 'AWS::AccountId' }, '-', { Ref: 'AWS::Region' }]] },
    });
    // Our own resources never embed the account; CDK's ExportReader role policy does (it must scope SSM ARNs).
    const ours = Object.entries(template.toJSON().Resources).filter(([id]) => !id.startsWith('Custom') && !id.startsWith('ExportsReader'));
    expect(JSON.stringify(ours)).not.toContain('222222222222');
  });

  test('GlobalStack refuses any concrete region other than us-east-1', () => {
    const app = new cdk.App();
    expect(() => new GlobalStack(app, 'G', { tier: ENVIRONMENTS.prod, env: { account: '222222222222', region: 'us-west-2' } })).toThrow(/us-east-1/);
  });
});

describe('09 · cross-region references', () => {
  test('strong mode (default in a bare App): ExportWriter in us-east-1, ExportReader in us-west-2, SSM under /cdk/exports', () => {
    const { prod } = synthPlatform();
    const global = Template.fromStack(prod.global!);
    const regional = Template.fromStack(prod.regional);

    global.resourceCountIs('Custom::CrossRegionExportWriter', 1);
    global.hasResourceProperties('Custom::CrossRegionExportWriter', {
      WriterProps: { region: 'us-west-2', exports: Match.anyValue() }, // the writer targets the *consumer's* region
    });
    const [writer] = Object.values(global.findResources('Custom::CrossRegionExportWriter'));
    const exports = writer.Properties.WriterProps.exports as Record<string, unknown>;
    // One SSM parameter per exported value: the L1 attribute and the L2 bucket ARN.
    expect(Object.keys(exports)).toHaveLength(2);
    for (const key of Object.keys(exports)) expect(key).toMatch(/^\/cdk\/exports\/revan-platform-prod-regional-usw2\//);
    expect(Object.values(exports)).toEqual(expect.arrayContaining([{ 'Fn::GetAtt': ['EdgeAcl', 'Arn'] }]));
    // The writer Lambda's role may write SSM parameters *in the consumer region only*.
    global.hasResourceProperties('AWS::IAM::Role', {
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: ['ssm:DeleteParameters', 'ssm:ListTagsForResource', 'ssm:GetParameters', 'ssm:PutParameter'],
                Resource: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ssm:us-west-2:222222222222:parameter/cdk/exports/*']] }],
              }),
            ]),
          },
        },
      ],
    });

    regional.resourceCountIs('Custom::CrossRegionExportReader', 1);
    regional.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/cdk-mastery/platform/prod/edge-acl-arn',
      Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^ExportsReader'), Match.stringLikeRegexp('^/cdk/exports/revan-platform-prod-regional-usw2/')] },
    });
    expect(global.toJSON().Outputs).toBeUndefined(); // no Output in strong mode: SSM carries the value
  });

  test('weak mode (cdk.json sets defaultCrossStackReferences=weak): plain Output + Fn::GetStackOutput, no Lambdas', () => {
    const { prod } = synthPlatform({ [cxapi.DEFAULT_CROSS_STACK_REFERENCES]: 'weak' });
    const global = Template.fromStack(prod.global!);
    const regional = Template.fromStack(prod.regional);

    global.resourceCountIs('Custom::CrossRegionExportWriter', 0);
    global.resourceCountIs('AWS::Lambda::Function', 0);
    const outputs = global.findOutputs('*');
    expect(Object.keys(outputs)).toHaveLength(2); // one per exported value (WebACL ARN, logs bucket ARN)
    for (const name of Object.keys(outputs)) expect(name).toMatch(/^PublishOutput/);
    const aclOutput = Object.entries(outputs).find(([, o]) => JSON.stringify(o.Value) === JSON.stringify({ 'Fn::GetAtt': ['EdgeAcl', 'Arn'] }))![0];

    regional.resourceCountIs('Custom::CrossRegionExportReader', 0);
    regional.resourceCountIs('AWS::Lambda::Function', 0);
    regional.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/cdk-mastery/platform/prod/edge-acl-arn',
      Value: { 'Fn::GetStackOutput': { StackName: 'revan-platform-prod-global-use1', Region: 'us-east-1', OutputName: aclOutput } },
    });
  });

  test('crossRegionReferences: L1 attributes cross regions regardless; L2 name/ARN attributes need the prop', () => {
    // (a) L1 attribute, no prop: wired anyway (2.269 behaviour).
    const app1 = new cdk.App();
    const g1 = new GlobalStack(app1, 'G', { tier: ENVIRONMENTS.prod, env: { account: '222222222222', region: 'us-east-1' } });
    const r1 = new RegionalStack(app1, 'R', { target: TARGETS.prod, env: TARGETS.prod.env, edgeWebAclArn: g1.webAclArn });
    Template.fromStack(r1).resourceCountIs('Custom::CrossRegionExportReader', 1);

    // (b) L2 bucket ARN, no prop, no explicit bucket name: the physical-name fallback fails at synth.
    const app2 = new cdk.App();
    const g2 = new GlobalStack(app2, 'G', { tier: ENVIRONMENTS.prod, env: { account: '222222222222', region: 'us-east-1' } });
    new RegionalStack(app2, 'R', { target: TARGETS.prod, env: TARGETS.prod.env, edgeLogsBucketArn: g2.edgeLogsBucket.bucketArn });
    expect(() => app2.synth()).toThrow(/Cannot use resource 'G\/EdgeLogs' in a cross-environment fashion/);

    // (c) L2 bucket ARN with the prop on both stacks: a real cross-region reference.
    const app3 = new cdk.App();
    const g3 = new GlobalStack(app3, 'G', { tier: ENVIRONMENTS.prod, env: { account: '222222222222', region: 'us-east-1' }, crossRegionReferences: true });
    const r3 = new RegionalStack(app3, 'R', { target: TARGETS.prod, env: TARGETS.prod.env, edgeLogsBucketArn: g3.edgeLogsBucket.bucketArn, crossRegionReferences: true });
    Template.fromStack(r3).hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/cdk-mastery/platform/prod/edge-logs-bucket-arn',
      Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^ExportsReader'), Match.stringLikeRegexp('^/cdk/exports/R/')] },
    });
  });
});

describe('09 · synthesizer and bootstrap qualifier', () => {
  test('qualifiers are ≤10 alphanumeric characters and distinct per tier', () => {
    const q = Object.values(ENVIRONMENTS).map(qualifierFor);
    expect(q).toEqual(['platdev', 'platstg', 'platprod']);
    for (const x of q) expect(x).toMatch(/^[A-Za-z0-9]{1,10}$/);
  });

  test('templates reference the tier bootstrap: SSM version parameter and asset bucket carry the qualifier', () => {
    const { prod, dev, assembly } = synthPlatform();
    const template = Template.fromStack(prod.regional);
    template.hasParameter('BootstrapVersion', { Default: '/cdk-bootstrap/platprod/version' });
    const rule = template.toJSON().Rules.CheckBootstrapVersion;
    expect(JSON.stringify(rule)).toMatch(/bootstrap stack version 6 required/);

    // The manifest tells the CLI which roles to assume — computed by the synthesizer, not the CLI.
    const artifact = assembly.getNestedAssembly(prod.artifactId).getStackByName('revan-platform-prod-regional-usw2');
    expect(artifact.assumeRoleArn).toBe('arn:${AWS::Partition}:iam::222222222222:role/cdk-platprod-deploy-role-222222222222-us-west-2');
    expect(artifact.cloudFormationExecutionRoleArn).toBe('arn:${AWS::Partition}:iam::222222222222:role/cdk-platprod-cfn-exec-role-222222222222-us-west-2');
    expect(artifact.stackTemplateAssetObjectUrl).toMatch(/^s3:\/\/cdk-platprod-assets-222222222222-us-west-2\//);
    expect(artifact.bootstrapStackVersionSsmParameter).toBe('/cdk-bootstrap/platprod/version');

    const devArtifact = assembly.getNestedAssembly(dev.artifactId).getStackByName('revan-platform-dev-regional-use1');
    expect(devArtifact.assumeRoleArn).toContain('cdk-platdev-deploy-role-111111111111-us-east-1');
  });

  test('the synthesizer substitutes ${Qualifier} placeholders; a fresh instance per stack keeps bindings independent', () => {
    const app = new cdk.App();
    const a = new cdk.Stack(app, 'A', { synthesizer: platformSynthesizer(ENVIRONMENTS.dev), env: TARGETS.dev.env });
    const b = new cdk.Stack(app, 'B', { synthesizer: platformSynthesizer(ENVIRONMENTS.prod), env: TARGETS.prod.env });
    expect(a.synthesizer.cloudFormationExecutionRole).toBe('arn:${AWS::Partition}:iam::111111111111:role/cdk-platdev-cfn-exec-role-111111111111-us-east-1');
    expect(b.synthesizer.cloudFormationExecutionRole).toBe('arn:${AWS::Partition}:iam::222222222222:role/cdk-platprod-cfn-exec-role-222222222222-us-west-2');
    expect((a.synthesizer as cdk.DefaultStackSynthesizer).bootstrapQualifier).toBe('platdev');
  });
});

describe('09 · feature flags are context', () => {
  test('a bare App sets none of the recommended flags; the repo cdk.json sets almost all', () => {
    const bare = missingRecommendedFlags(new cdk.App());
    expect(bare.length).toBeGreaterThan(50);

    const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../cdk.json'), 'utf8')) as { context: Record<string, unknown> };
    const pinned = missingRecommendedFlags(new cdk.App({ context: cdkJson.context }));
    // Every recommended flag that cdk.json does not pin is listed here on purpose; review this list on every upgrade.
    // (aspectStabilization is recommended in its FlagInfo but not part of CURRENTLY_RECOMMENDED_FLAGS, hence absent here.)
    expect(pinned.map((f) => f.flag)).toEqual(['@aws-cdk/aws-ecs:removeEmptyLoadBalancers']);
  });

  test('the flags this module depends on read differently in tests and under cdk.json', () => {
    const bare = new cdk.App();
    expect(flagValue(bare, cxapi.DEFAULT_CROSS_STACK_REFERENCES)).toBeUndefined();
    const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../cdk.json'), 'utf8')) as { context: Record<string, unknown> };
    const configured = new cdk.App({ context: cdkJson.context });
    expect(flagValue(configured, cxapi.DEFAULT_CROSS_STACK_REFERENCES)).toBe('weak');
    for (const flag of FLAGS_WE_DEPEND_ON) expect(cxapi.FLAGS[flag]).toBeDefined();
    expect(cdk.FeatureFlags.of(configured).isEnabled(cxapi.ASPECT_PRIORITIES_MUTATING)).toBe(true);
    expect(cdk.FeatureFlags.of(bare).isEnabled(cxapi.ASPECT_PRIORITIES_MUTATING)).toBe(false);
  });
});

describe('09 · exercises', () => {
  test('exercise 1: the shipped table is valid; a bad table is caught rule by rule', () => {
    const allowed = ['us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1'];
    expect(validateTargets(TARGETS, allowed)).toEqual([]);

    const bad: Record<string, DeploymentTarget> = {
      dev: { tier: ENVIRONMENTS.dev, env: { account: '222222222222', region: 'us-east1' } },
      prod: { tier: ENVIRONMENTS.prod, env: { account: '222222222222', region: 'ap-south-1' }, globalRegion: 'us-east-1' },
    };
    const rules = validateTargets(bad, allowed).map((v) => `${v.tier}:${v.rule}`).sort();
    expect(rules).toEqual(['dev:region-allowlist', 'dev:region-format', 'prod:prod-isolation', 'prod:region-allowlist']);
  });

  test('exercise 2: RegionConfig renders Fn::FindInMap for agnostic stacks, a literal for concrete regions, and fails for unknown ones', () => {
    const byRegion = { 'us-east-1': { amiOwner: '111' }, 'us-west-2': { amiOwner: '222' } };

    const agnostic = new cdk.Stack(new cdk.App(), 'Agnostic');
    new cdk.CfnOutput(agnostic, 'Owner', { value: new RegionConfig(agnostic, 'Cfg', { byRegion }).get('amiOwner') });
    // The mapping sits under a construct, so its logical id is hashed (CfgMapping<hash>).
    Template.fromStack(agnostic).hasOutput('Owner', { Value: { 'Fn::FindInMap': [Match.stringLikeRegexp('^CfgMapping'), { Ref: 'AWS::Region' }, 'amiOwner'] } });
    expect(Object.values(Template.fromStack(agnostic).findMappings('*'))).toEqual([byRegion]);

    const concrete = new cdk.Stack(new cdk.App(), 'Concrete', { env: { account: '111111111111', region: 'us-west-2' } });
    new cdk.CfnOutput(concrete, 'Owner', { value: new RegionConfig(concrete, 'Cfg', { byRegion }).get('amiOwner') });
    Template.fromStack(concrete).hasOutput('Owner', { Value: '222' }); // lazy mapping resolved at synth time
    expect(Template.fromStack(concrete).toJSON().Mappings).toBeUndefined();

    const unknown = new cdk.Stack(new cdk.App(), 'Unknown', { env: { account: '111111111111', region: 'eu-central-1' } });
    expect(() => new RegionConfig(unknown, 'Cfg', { byRegion })).toThrow(/no entry for region eu-central-1/);
  });

  test('exercise 3: MultiRegionStage fans a tier out with unique names, one writer and N readers', () => {
    const app = new cdk.App();
    const stage = new MultiRegionStage(app, 'Fan', { target: TARGETS.prod, replicaRegions: ['eu-west-1', 'ap-southeast-2'] });
    const asm = app.synth().getNestedAssembly(stage.artifactId);

    const names = asm.stacks.map((s) => s.stackName).sort();
    expect(names).toEqual([
      'revan-platform-prod-global-use1',
      'revan-platform-prod-regional-aps2', // regionShortCode('ap-southeast-2')
      'revan-platform-prod-regional-euw1',
      'revan-platform-prod-regional-usw2',
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(asm.stacks.map((s) => s.environment.region).sort()).toEqual(['ap-southeast-2', 'eu-west-1', 'us-east-1', 'us-west-2']);

    // One writer resource in the global stack targets all three consumer regions.
    const global = Template.fromStack(stage.global);
    const writers = global.findResources('Custom::CrossRegionExportWriter');
    expect(Object.values(writers).map((w) => w.Properties.WriterProps.region).sort()).toEqual(['ap-southeast-2', 'eu-west-1', 'us-west-2']);
    for (const regional of stage.regional.values()) Template.fromStack(regional).resourceCountIs('Custom::CrossRegionExportReader', 1);

    expect(() => new MultiRegionStage(app, 'Dup', { target: TARGETS.prod, replicaRegions: ['us-west-2'] })).toThrow(/Duplicate regions/);
  });
});
