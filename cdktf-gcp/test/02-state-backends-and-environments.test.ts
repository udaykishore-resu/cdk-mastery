import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App, Testing } from 'cdktf';
import { ComputeFirewall } from '@cdktf/provider-google/lib/compute-firewall';
import { ComputeAddress } from '@cdktf/provider-google/lib/compute-address';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { PubsubTopicIamMember } from '@cdktf/provider-google/lib/pubsub-topic-iam-member';
import {
  AppStack,
  EnvironmentStack,
  NetworkStack,
  RefactorStack,
  addEnvironmentStacks,
  addToApp,
  configureBackend,
  useCloudBackend,
  useHttpBackend,
} from '../src/modules/02-state-backends-and-environments';
import { ContractConsumerStack } from '../src/modules/02-state-backends-and-environments/solutions/01-explicit-contract';
import { WorkspaceStack } from '../src/modules/02-state-backends-and-environments/solutions/02-workspace-style';
import { buildCycle, buildFixed } from '../src/modules/02-state-backends-and-environments/solutions/03-break-the-cycle';
import { ENVIRONMENTS } from '@cdk-mastery/shared';

Testing.setupJest();


/** True when `terraform` (or `$TERRAFORM_BINARY_NAME`, e.g. `tofu`) is on PATH — the cdktf version validation shells out to it. */
function terraformOnPath(): boolean {
  try {
    require('node:child_process').execSync(`${process.env.TERRAFORM_BINARY_NAME ?? 'terraform'} version`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('02 · backends', () => {
  it('uses the local backend when CDKM_STATE_BUCKET is unset (offline default)', () => {
    const prev = process.env.CDKM_STATE_BUCKET;
    delete process.env.CDKM_STATE_BUCKET;
    try {
      const stack = new NetworkStack(Testing.app(), 'm02-network', { tier: 'dev' });
      stack.prepareStack(); // App.synth() does this; it adds the default backend
      const json = JSON.parse(Testing.synth(stack));
      expect(json.terraform.backend.local.path).toMatch(/terraform\.m02-network\.tfstate$/);
    } finally {
      if (prev !== undefined) process.env.CDKM_STATE_BUCKET = prev;
    }
  });

  it('switches to a GCS backend with a per-stack prefix when a bucket is given', () => {
    const stack = new NetworkStack(Testing.app(), 'm02-network', { tier: 'dev', state: { bucket: 'tf-state', kmsEncryptionKey: 'projects/p/locations/us/keyRings/r/cryptoKeys/k' } });
    const json = JSON.parse(Testing.synth(stack));
    expect(json.terraform.backend).toEqual({
      gcs: { bucket: 'tf-state', prefix: 'm02-network', kms_encryption_key: 'projects/p/locations/us/keyRings/r/cryptoKeys/k' },
    });
    expect(json['//']).toBeUndefined(); // Testing.synth strips metadata; fullSynth keeps it
  });

  it('honours the CDKM_STATE_BUCKET environment variable', () => {
    process.env.CDKM_STATE_BUCKET = 'env-bucket';
    try {
      const stack = new EnvironmentStack(Testing.app(), 'm02-env-prod', { tier: ENVIRONMENTS.prod });
      expect(JSON.parse(Testing.synth(stack)).terraform.backend.gcs).toEqual({ bucket: 'env-bucket', prefix: 'env/prod' });
    } finally {
      delete process.env.CDKM_STATE_BUCKET;
    }
  });

  it('configureBackend returns undefined and adds nothing when no bucket is known', () => {
    const stack = new NetworkStack(Testing.app(), 'x', { tier: 'dev' });
    expect(configureBackend(stack, 'x')).toBeUndefined();
  });

  it('CloudBackend renders terraform.cloud with a named workspace; HttpBackend renders lock endpoints', () => {
    const app = Testing.app();
    const cloud = new NetworkStack(app, 'cloud', { tier: 'dev' });
    useCloudBackend(cloud, 'acme', 'network-dev', 'app.terraform.io');
    expect(JSON.parse(Testing.synth(cloud)).terraform.cloud).toEqual({
      organization: 'acme',
      hostname: 'app.terraform.io',
      workspaces: { name: 'network-dev' },
    });

    const http = new NetworkStack(app, 'http', { tier: 'dev' });
    useHttpBackend(http, 'https://gitlab.example.com/api/v4/projects/1/terraform/state/network');
    expect(JSON.parse(Testing.synth(http)).terraform.backend.http).toEqual({
      address: 'https://gitlab.example.com/api/v4/projects/1/terraform/state/network',
      lock_address: 'https://gitlab.example.com/api/v4/projects/1/terraform/state/network/lock',
      lock_method: 'POST',
      unlock_address: 'https://gitlab.example.com/api/v4/projects/1/terraform/state/network/lock',
      unlock_method: 'DELETE',
      retry_max: 3,
    });
  });
});

describe('02 · cross-stack references', () => {
  const app = Testing.app();
  const network = new NetworkStack(app, 'm02-network', { tier: 'dev', state: { bucket: 'tf-state' } });
  const appStack = new AppStack(app, 'm02-app', { tier: 'dev', network, state: { bucket: 'tf-state' } });

  it('before prepareStack the reference is a plain interpolation into the other stack (not deployable)', () => {
    const fresh = Testing.app();
    const n = new NetworkStack(fresh, 'n', { tier: 'dev' });
    const a = new AppStack(fresh, 'a', { tier: 'dev', network: n });
    expect(JSON.parse(Testing.synth(a)).resource.google_compute_firewall.AllowIapSsh.network).toBe('${google_compute_network.Vpc.id}');
  });

  it('after prepareStack: consumer gets terraform_remote_state, producer gets a sensitive output, manifest records the dependency', () => {
    appStack.prepareStack();
    const consumer = JSON.parse(Testing.synth(appStack));
    const producer = JSON.parse(Testing.synth(network));

    expect(consumer.data.terraform_remote_state['cross-stack-reference-input-m02-network']).toEqual({
      backend: 'gcs',
      config: { bucket: 'tf-state', prefix: 'm02-network' },
      workspace: '${terraform.workspace}',
    });
    expect(consumer.resource.google_compute_firewall.AllowIapSsh.network).toBe(
      '${data.terraform_remote_state.cross-stack-reference-input-m02-network.outputs.cross-stack-output-google_compute_networkVpcid}',
    );
    expect(producer.output['cross-stack-output-google_compute_networkVpcid']).toEqual({
      value: '${google_compute_network.Vpc.id}',
      sensitive: true,
    });
    // The explicit contract output is still there, unchanged.
    expect(producer.output.network_id).toEqual({ value: '${google_compute_network.Vpc.id}', description: 'Full resource id of the VPC' });
    expect(appStack.dependencies.map((d) => d.node.id)).toEqual(['m02-network']);
    expect(network.dependencies).toEqual([]);
  });

  it('App.synth() writes the dependency into manifest.json, which is what cdktf deploy orders by', () => {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdktf-m02-'));
    const a = new App({ outdir });
    addToApp(a);
    a.synth();
    const manifest = JSON.parse(fs.readFileSync(path.join(outdir, 'manifest.json'), 'utf8'));
    expect(manifest.stacks['m02-app'].dependencies).toEqual(['m02-network']);
    expect(manifest.stacks['m02-network'].dependencies).toEqual([]);
    expect(Object.keys(manifest.stacks).sort()).toEqual(['m02-app', 'm02-env-dev', 'm02-env-prod', 'm02-env-staging', 'm02-network']);
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  it('DataTerraformRemoteStateGcs reads an HCL-managed stack by bucket/prefix and output name', () => {
    const fresh = Testing.app();
    const n = new NetworkStack(fresh, 'n', { tier: 'dev' });
    const a = new AppStack(fresh, 'a', { tier: 'dev', network: n, legacyState: { bucket: 'legacy-state', prefix: 'legacy/network' } });
    const synth = Testing.synth(a);
    const json = JSON.parse(synth);
    expect(json.data.terraform_remote_state.LegacyNetwork).toEqual({
      backend: 'gcs',
      config: { bucket: 'legacy-state', prefix: 'legacy/network' },
      defaults: {},
    });
    expect(synth).toHaveResourceWithProperties(ComputeAddress, {
      address_type: 'INTERNAL',
      subnetwork: '${data.terraform_remote_state.LegacyNetwork.outputs.subnet_self_link}',
    });
    // Reading state is not a stack dependency: the manifest stays independent.
    expect(a.dependencies).toEqual([]);
  });

  it('full synth of both stacks succeeds', () => {
    for (const s of [network, appStack]) {
      const outdir = Testing.fullSynth(s);
      expect(fs.existsSync(path.join(outdir, 'stacks', s.node.id, 'cdk.tf.json'))).toBe(true);
      fs.rmSync(outdir, { recursive: true, force: true });
    }
  });
});

describe('02 · stack-per-environment', () => {
  const app = Testing.app();
  const stacks = addEnvironmentStacks(app);

  it('creates one stack per tier with its own state prefix and provider', () => {
    expect(Object.keys(stacks)).toEqual(['dev', 'staging', 'prod']);
    expect(app.node.children.map((c) => c.node.id)).toEqual(['m02-env-dev', 'm02-env-staging', 'm02-env-prod']);
    const prod = new EnvironmentStack(Testing.app(), 'p', { tier: ENVIRONMENTS.prod, state: { bucket: 'b' } });
    expect(JSON.parse(Testing.synth(prod)).terraform.backend.gcs.prefix).toBe('env/prod');
  });

  it('tier differences are synth-time decisions, so tests can assert them per environment', () => {
    const dev = Testing.synth(stacks.dev);
    const prod = Testing.synth(stacks.prod);
    expect(dev).toHaveResourceWithProperties(StorageBucket, {
      name: 'cdkm-state-dev-data',
      force_destroy: true,
      versioning: { enabled: false },
      storage_class: 'NEARLINE',
      lifecycle: { prevent_destroy: false },
    });
    expect(prod).toHaveResourceWithProperties(StorageBucket, {
      name: 'cdkm-state-prod-data',
      force_destroy: false,
      versioning: { enabled: true },
      storage_class: 'STANDARD',
      lifecycle: { prevent_destroy: true },
      labels: expect.objectContaining({ environment: 'prod', 'cost-center': 'cc-platform-prod' }),
    });
  });
});

describe('02 · state surgery in code', () => {
  const json = JSON.parse(Testing.synth(new RefactorStack(Testing.app(), 'm02-refactor', { tier: 'dev', adoptBucketName: 'pre-existing' })));

  it('moveFromId emits a moved block for the rename', () => {
    expect(json.moved).toContainEqual({ from: 'google_compute_network.legacy_network', to: 'google_compute_network.Vpc' });
  });

  it('moveTo with an index targets one instance of a for_each resource and hides the old resource block', () => {
    expect(json.moved).toContainEqual({ from: 'google_storage_bucket.RawBucket', to: 'google_storage_bucket.Buckets["raw"]' });
    expect(json.resource.google_storage_bucket.RawBucket).toBeUndefined();
    expect(json.resource.google_storage_bucket.Buckets.for_each).toBe('${toset(["raw", "curated"])}');
  });

  it('importFrom emits a Terraform 1.5 import block bound to the provider', () => {
    expect(json.import).toEqual([{ id: 'pre-existing', to: 'google_storage_bucket.Adopted', provider: 'google' }]);
    expect(json.resource.google_storage_bucket.Adopted.name).toBe('pre-existing');
  });

  it('moved/import register a Terraform >= 1.5 validation that needs the binary at App.synth()', () => {
    const stack = new RefactorStack(Testing.app(), 'r', { tier: 'dev', adoptBucketName: 'x' });
    const messages = stack.node.findAll().flatMap((n) => n.node.validate());
    if (terraformOnPath()) {
      // With a (>= 1.5) binary the validation is satisfied and reports nothing.
      expect(messages).toEqual([]);
    } else {
      // Without a terraform binary the validation reports the failure to detect a version.
      expect(messages.join('\n')).toMatch(/terraform/i);
    }
    // Which is why addToApp gates the stack behind CDKM_ENABLE_REFACTOR_STACK.
    const app = Testing.app();
    delete process.env.CDKM_ENABLE_REFACTOR_STACK;
    addToApp(app);
    expect(app.node.children.map((c) => c.node.id)).not.toContain('m02-refactor');
    process.env.CDKM_ENABLE_REFACTOR_STACK = '1';
    const gated = Testing.app();
    addToApp(gated);
    delete process.env.CDKM_ENABLE_REFACTOR_STACK;
    expect(gated.node.children.map((c) => c.node.id)).toContain('m02-refactor');
  });
});

describe('02 · exercise solutions', () => {
  it('1: explicit contract via remote state — no manifest dependency, output name is the API', () => {
    const gcs = new ContractConsumerStack(Testing.app(), 'x', { tier: 'dev', networkState: { kind: 'gcs', bucket: 'tf-state', prefix: 'm02-network' } });
    const synth = Testing.synth(gcs);
    const json = JSON.parse(synth);
    expect(json.data.terraform_remote_state.Network).toEqual({ backend: 'gcs', config: { bucket: 'tf-state', prefix: 'm02-network' } });
    expect(synth).toHaveResourceWithProperties(ComputeFirewall, {
      network: '${data.terraform_remote_state.Network.outputs.network_id}',
      source_ranges: ['35.191.0.0/16', '130.211.0.0/22'],
    });
    expect(gcs.dependencies).toEqual([]);

    const local = new ContractConsumerStack(Testing.app(), 'y', { tier: 'dev', networkState: { kind: 'local', path: '../m02-network/terraform.tfstate' } });
    expect(JSON.parse(Testing.synth(local)).data.terraform_remote_state.Network).toEqual({
      backend: 'local',
      config: { path: '../m02-network/terraform.tfstate' },
    });
  });

  it('2: workspace style pushes every environment decision into Terraform expressions', () => {
    const json = JSON.parse(Testing.synth(new WorkspaceStack(Testing.app(), 'ws', { project: 'p' })));
    const bucket = json.resource.google_storage_bucket.Data;
    expect(bucket.name).toBe('${format("cdkm-state-%s-ws-data", terraform.workspace)}');
    expect(bucket.force_destroy).toBe('${!lookup(lookup(local.tiers, terraform.workspace, {}), "retain", true)}');
    expect(bucket.lifecycle.precondition[0].condition).toBe('${(terraform.workspace == var.environment)}');
    expect(json.locals.tiers.prod).toEqual({ retain: true, retention_days: 365, cost_center: 'cc-platform-prod' });
    expect(json.variable.environment.validation[0].condition).toBe('${contains(["dev", "staging", "prod"], var.environment)}');
    // The point of the exercise: nothing here distinguishes prod from dev at synth time.
    expect(JSON.stringify(bucket)).not.toContain('"force_destroy":false');
  });

  it('3: a two-way reference is rejected at prepareStack; the fixed shape has one direction', () => {
    const { a, b } = buildCycle(Testing.app(), 'proj');
    expect(() => {
      a.prepareStack();
      b.prepareStack();
    }).toThrow(/circular dependency/);

    const fixed = buildFixed(Testing.app(), 'proj');
    fixed.a.prepareStack();
    fixed.b.prepareStack();
    expect(fixed.a.dependencies.map((s) => s.node.id)).toEqual(['fixed-b']);
    expect(fixed.b.dependencies).toEqual([]);
    expect(Testing.synth(fixed.b)).toHaveResourceWithProperties(PubsubTopicIamMember, {
      member: 'serviceAccount:svc-a-publisher@proj.iam.gserviceaccount.com',
      role: 'roles/pubsub.publisher',
    });
  });
});
