import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App, LocalBackend, Testing } from 'cdktf';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { HelloStack, addToApp } from '../src/modules/00-introduction';
import { HardenedHelloStack } from '../src/modules/00-introduction/solutions/01-hardened-hello-stack';
import { deployOrder, describeSynth } from '../src/modules/00-introduction/solutions/02-read-manifest';
import { LocalStateHelloStack, renderHcl } from '../src/modules/00-introduction/solutions/03-hcl-and-local-state';

// test/setup.ts imports the jest adapter module but the matchers are only
// registered by this call; it is idempotent, so every test file makes it.
Testing.setupJest();

describe('00 · HelloStack', () => {
  const app = Testing.app();
  const stack = new HelloStack(app, 'm00-hello', { tier: 'dev', project: 'proj', region: 'europe-west1' });
  const synth = Testing.synth(stack);
  const json = JSON.parse(synth);

  it('declares exactly one google provider with the project and region baked in at synth time', () => {
    expect(synth).toHaveProviderWithProperties(GoogleProvider, { project: 'proj', region: 'europe-west1' });
    expect(json.provider.google).toHaveLength(1);
  });

  it('pins the provider version from the prebuilt package in terraform.required_providers', () => {
    expect(json.terraform.required_providers.google).toEqual({ source: 'google', version: '6.50.0' });
  });

  it('creates a versioned, uniform-access bucket named by the shared convention and labelled from the tier', () => {
    expect(synth).toHaveResourceWithProperties(StorageBucket, {
      name: 'cdkm-hello-dev-artifacts',
      location: 'US',
      uniform_bucket_level_access: true,
      versioning: { enabled: true },
      force_destroy: true,
      labels: expect.objectContaining({ environment: 'dev', 'managed-by': 'cdk-mastery', 'cost-center': 'cc-platform-dev' }),
    });
  });

  it('uses the construct id as the logical id for top-level resources', () => {
    expect(Object.keys(json.resource.google_storage_bucket)).toEqual(['Artifacts']);
  });

  it('emits outputs whose values are interpolations, not strings — the bucket name is only known after apply', () => {
    expect(json.output.BucketName.value).toBe('${google_storage_bucket.Artifacts.name}');
    expect(json.output.BucketUrl.value).toBe('${google_storage_bucket.Artifacts.url}');
  });

  it('prod keeps stateful resources: force_destroy is false', () => {
    const prod = Testing.synth(new HelloStack(Testing.app(), 'prod', { tier: 'prod' }));
    expect(prod).toHaveResourceWithProperties(StorageBucket, { force_destroy: false, name: 'cdkm-hello-prod-artifacts' });
  });

  it('full synth writes manifest.json and stacks/<name>/cdk.tf.json', () => {
    const outdir = Testing.fullSynth(stack);
    expect(fs.existsSync(path.join(outdir, 'manifest.json'))).toBe(true);
    const file = path.join(outdir, 'stacks', 'm00-hello', 'cdk.tf.json');
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written['//'].metadata).toMatchObject({ stackName: 'm00-hello', backend: 'local' });
    // Testing.fullSynth skips prepareStack(), so the default backend block is absent here...
    expect(written.terraform.backend).toBeUndefined();
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  it('App.synth() runs prepareStack(), which adds the default local backend keyed by stack name', () => {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdktf-m00-'));
    const app = new App({ outdir });
    new HelloStack(app, 'm00-hello', { tier: 'dev' });
    app.synth();
    const written = JSON.parse(fs.readFileSync(path.join(outdir, 'stacks', 'm00-hello', 'cdk.tf.json'), 'utf8'));
    // ...and this is what `cdktf synth` produces: an absolute path derived from process.cwd().
    expect(written.terraform.backend.local.path).toBe(path.join(process.cwd(), 'terraform.m00-hello.tfstate'));
    fs.rmSync(outdir, { recursive: true, force: true });
  });
});

describe('00 · addToApp', () => {
  it('registers the stack under the id m00-hello', () => {
    const app = Testing.app();
    addToApp(app);
    expect(app.node.children.map((c) => c.node.id)).toEqual(['m00-hello']);
  });
});

describe('00 · exercise solutions', () => {
  it('1: hardened bucket enforces public-access prevention and expires non-current versions per tier', () => {
    const synth = Testing.synth(new HardenedHelloStack(Testing.app(), 'x', { tier: 'staging' }));
    expect(synth).toHaveResourceWithProperties(StorageBucket, {
      public_access_prevention: 'enforced',
      force_destroy: true,
      lifecycle_rule: [
        { action: { type: 'Delete' }, condition: { days_since_noncurrent_time: 30, with_state: 'ARCHIVED' } },
        { action: { type: 'Delete' }, condition: { num_newer_versions: 3, with_state: 'ARCHIVED' } },
      ],
    });
  });

  it('2: describeSynth reads the manifest index and deployOrder sorts stacks topologically', () => {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdktf-m00-'));
    const app = new App({ outdir });
    new HelloStack(app, 'm00-hello', { tier: 'dev' });
    app.synth();
    const summary = describeSynth(outdir);
    expect(summary.stacks).toEqual([
      expect.objectContaining({
        name: 'm00-hello',
        configPath: 'stacks/m00-hello/cdk.tf.json',
        dependencies: [],
        resourceCount: 1,
        sections: expect.arrayContaining(['provider', 'resource', 'output', 'terraform']),
      }),
    ]);
    expect(deployOrder(summary)).toEqual(['m00-hello']);
    fs.rmSync(outdir, { recursive: true, force: true });

    // The ordering also handles a chain and rejects a cycle.
    const chain = {
      version: 'x',
      stacks: [
        { name: 'app', configPath: '', dependencies: ['db', 'net'], sections: [], resourceCount: 0 },
        { name: 'db', configPath: '', dependencies: ['net'], sections: [], resourceCount: 0 },
        { name: 'net', configPath: '', dependencies: [], sections: [], resourceCount: 0 },
      ],
    };
    expect(deployOrder(chain)).toEqual(['net', 'db', 'app']);
    expect(() =>
      deployOrder({
        version: 'x',
        stacks: [
          { name: 'a', configPath: '', dependencies: ['b'], sections: [], resourceCount: 0 },
          { name: 'b', configPath: '', dependencies: ['a'], sections: [], resourceCount: 0 },
        ],
      }),
    ).toThrow(/Circular/);
  });

  it('3: HCL rendering contains the same resource addresses as the JSON, and an explicit LocalBackend moves state', () => {
    const app = Testing.app();
    const stack = new LocalStateHelloStack(app, 'm00-local', { tier: 'dev', stateDir: 'state' });
    const { hcl, addresses } = renderHcl(stack);
    expect(addresses).toEqual(['google_storage_bucket.Artifacts']);
    expect(hcl).toContain('provider "google" {');
    expect(hcl).toContain('backend "local" {');
    expect(hcl).toContain('path = "state/m00-local.tfstate"');

    const json = JSON.parse(Testing.synth(stack));
    expect(json.terraform.backend).toEqual({ local: { path: 'state/m00-local.tfstate' } });

    // A backend is a per-stack singleton.
    expect(() => new LocalBackend(stack, { path: 'other.tfstate' })).toThrow(/backend/);
  });
});
