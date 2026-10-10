import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cxapi from 'aws-cdk-lib/cx-api';
import { addToApp, HelloStack, LifecyclePhases } from '../src/modules/00-introduction';
import { ScopedHelloStack } from '../src/modules/00-introduction/solutions/exercise-1-scoped-stack';
import { formatReport, reportAssembly } from '../src/modules/00-introduction/solutions/exercise-2-assembly-report';
import { QualifiedStack } from '../src/modules/00-introduction/solutions/exercise-3-custom-qualifier';

afterAll(cxapi.CloudAssembly.cleanupTemporaryDirectories);

describe('00 · HelloStack — the construct tree', () => {
  const app = new cdk.App();
  const stack = new HelloStack(app, 'M00-Hello', { tier: 'dev' });
  const template = Template.fromStack(stack);

  test('one L2 Bucket with enforceSSL produces two CloudFormation resources', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::S3::BucketPolicy', 1);
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
        ]),
      },
    });
  });

  test('the L2 owns an L1 child called Resource, reachable via node.defaultChild', () => {
    expect(stack.bucket.node.defaultChild).toBeInstanceOf(cdk.CfnResource);
    expect(stack.bucket.node.defaultChild!.node.path).toBe('M00-Hello/Artifacts/Resource');
  });

  test('logical IDs are path-derived: top-level id + 8 hex chars of path hash', () => {
    const l1 = stack.bucket.node.defaultChild as cdk.CfnResource;
    expect(stack.getLogicalId(l1)).toMatch(/^Artifacts[0-9A-F]{8}$/);
    // Outputs directly under the stack keep their id verbatim (no hash for depth-1 children).
    template.hasOutput('BucketName', {});
  });

  test('env-agnostic stack: region is a token that resolves to Ref AWS::Region', () => {
    expect(cdk.Token.isUnresolved(stack.region)).toBe(true);
    expect(stack.resolve(stack.region)).toEqual({ Ref: 'AWS::Region' });
  });

  test('bucket name follows the shared naming convention', () => {
    template.hasResourceProperties('AWS::S3::Bucket', { BucketName: 'cdkm-hello-dev-artifacts' });
  });

  test('every DefaultStackSynthesizer stack carries the bootstrap version contract', () => {
    template.hasParameter('BootstrapVersion', {
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: '/cdk-bootstrap/hnb659fds/version',
    });
    const rules = template.toJSON().Rules;
    expect(rules.CheckBootstrapVersion).toBeDefined();
  });
});

describe('00 · synth lifecycle order', () => {
  test('construct -> aspects -> reference resolution -> validate -> synthesize', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Probe');
    const phases = new LifecyclePhases(stack, 'Phases');
    // Before synthesis only the constructor has run.
    expect(phases.events).toEqual(['construct']);

    const template = Template.fromStack(stack);
    expect(phases.events).toEqual([
      'construct',
      'prepare:aspects',
      'prepare:resolve-references',
      'validate',
      'synthesize',
    ]);
    // ...and the same order is baked into the template, proving Lazy resolves at synth time.
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Value: 'construct -> prepare:aspects -> prepare:resolve-references -> validate -> synthesize',
    });
  });

  test('a failing validation aborts synthesis with the construct path in the message', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Probe');
    const c = new LifecyclePhases(stack, 'Phases');
    c.node.addValidation({ validate: () => ['tier must be one of dev|staging|prod'] });
    expect(() => Template.fromStack(stack)).toThrow(/Probe\/Phases\] tier must be one of/);
  });
});

describe('00 · addToApp and the cloud assembly (cdk.out)', () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'm00-test-'));
  const app = new cdk.App({ outdir });
  addToApp(app);
  const assembly = app.synth();

  test('registers exactly one stack with the curriculum prefix', () => {
    expect(assembly.stacks.map((s) => s.stackName)).toEqual(['M00-Hello']);
  });

  test('writes the documented file set', () => {
    const files = fs.readdirSync(outdir).sort();
    expect(files).toEqual(
      expect.arrayContaining([
        'cdk.out',
        'manifest.json',
        'tree.json',
        'M00-Hello.template.json',
        'M00-Hello.assets.json',
      ]),
    );
    expect(JSON.parse(fs.readFileSync(path.join(outdir, 'cdk.out'), 'utf8'))).toEqual({ version: assembly.version });
  });

  test('manifest declares the stack, its asset manifest and the tree artifact', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(outdir, 'manifest.json'), 'utf8'));
    expect(manifest.artifacts['M00-Hello'].type).toBe('aws:cloudformation:stack');
    expect(manifest.artifacts['M00-Hello'].dependencies).toContain('M00-Hello.assets');
    expect(manifest.artifacts['M00-Hello.assets'].type).toBe('cdk:asset-manifest');
    expect(manifest.artifacts.Tree.type).toBe('cdk:tree');
  });

  test('an env-agnostic stack is recorded as unknown-account/unknown-region', () => {
    const artifact = assembly.getStackByName('M00-Hello');
    expect(artifact.environment.name).toBe('aws://unknown-account/unknown-region');
    expect(artifact.requiresBootstrapStackVersion).toBe(6);
    expect(artifact.bootstrapStackVersionSsmParameter).toBe('/cdk-bootstrap/hnb659fds/version');
    expect(artifact.assumeRoleArn).toContain('cdk-hnb659fds-deploy-role-');
    expect(artifact.cloudFormationExecutionRoleArn).toContain('cdk-hnb659fds-cfn-exec-role-');
  });

  test('the template itself is a file asset published via the file-publishing role', () => {
    const assets = JSON.parse(fs.readFileSync(path.join(outdir, 'M00-Hello.assets.json'), 'utf8'));
    const [templateAsset] = Object.values(assets.files) as Array<{ source: { path: string }; destinations: Record<string, { assumeRoleArn: string; bucketName: string }> }>;
    expect(templateAsset.source.path).toBe('M00-Hello.template.json');
    const [dest] = Object.values(templateAsset.destinations);
    expect(dest.bucketName).toBe('cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}');
    expect(dest.assumeRoleArn).toContain('cdk-hnb659fds-file-publishing-role-');
  });

  test('tree.json mirrors app.node.findAll()', () => {
    const tree = JSON.parse(fs.readFileSync(path.join(outdir, 'tree.json'), 'utf8'));
    expect(tree.version).toBe('tree-0.1');
    expect(tree.tree.children['M00-Hello'].children.Artifacts.children.Resource.constructInfo.fqn).toBe('aws-cdk-lib.aws_s3.CfnBucket');
  });

  test('exercise 2: reportAssembly summarises resource types per stack', () => {
    const [report] = reportAssembly(assembly);
    expect(report.stackName).toBe('M00-Hello');
    expect(report.resourceTypes).toEqual({
      'AWS::S3::Bucket': 1,
      'AWS::S3::BucketPolicy': 1,
      'AWS::SSM::Parameter': 2,
    });
    expect(report.outputs).toEqual(['BucketName']);
    expect(report.dependencies).toEqual(['M00-Hello.assets']);
    expect(formatReport([report])).toContain('AWS::S3::Bucket x1');
  });
});

describe('00 · exercise 1: an intermediate scope changes the logical ID', () => {
  test('wrapping the bucket in Storage renames the resource', () => {
    const app = new cdk.App();
    const stack = new ScopedHelloStack(app, 'M00-Scoped');
    const l1 = stack.storage.bucket.node.defaultChild as cdk.CfnResource;
    expect(l1.node.path).toBe('M00-Scoped/Storage/Artifacts/Resource');
    expect(stack.getLogicalId(l1)).toMatch(/^StorageArtifacts[0-9A-F]{8}$/);
  });
});

describe('00 · exercise 3: a custom bootstrap qualifier', () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'm00-q-'));
  const app = new cdk.App({ outdir });
  const stack = new QualifiedStack(app, 'M00-Qualified', { qualifier: 'cdkm2026' });

  test('the BootstrapVersion parameter points at the qualifier-specific SSM parameter', () => {
    Template.fromStack(stack).hasParameter('BootstrapVersion', { Default: '/cdk-bootstrap/cdkm2026/version' });
  });

  test('all synthesizer roles and the asset bucket embed the qualifier', () => {
    const artifact = app.synth().getStackByName('M00-Qualified');
    expect(artifact.assumeRoleArn).toContain('cdk-cdkm2026-deploy-role-');
    expect(artifact.cloudFormationExecutionRoleArn).toContain('cdk-cdkm2026-cfn-exec-role-');
    expect(artifact.stackTemplateAssetObjectUrl).toContain('s3://cdk-cdkm2026-assets-');
  });
});
