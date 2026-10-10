import * as fs from 'fs';
import * as path from 'path';
import { Aspects, Manifest, TerraformStack, Testing } from 'cdktf';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { BigqueryTable } from '@cdktf/provider-google/lib/bigquery-table';
import { PubsubTopic } from '@cdktf/provider-google/lib/pubsub-topic';
import { PubsubSubscription } from '@cdktf/provider-google/lib/pubsub-subscription';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { StorageBucketIamMember } from '@cdktf/provider-google/lib/storage-bucket-iam-member';
import { ConvertedStack, InteropStack, OverridesStack, RefactorStack } from '../src/modules/10-escape-hatches-hcl-migration-and-interop';
import { adopt, importId } from '../src/modules/10-escape-hatches-hcl-migration-and-interop/solutions/adopt-existing';
import { ConvertedForEachStack } from '../src/modules/10-escape-hatches-hcl-migration-and-interop/solutions/converted-foreach';
import { PinnedIdsStack, PinnedLogicalIdsAspect } from '../src/modules/10-escape-hatches-hcl-migration-and-interop/solutions/pinned-logical-ids';

Testing.setupJest();
const itIfTerraform = process.env.CDKM_TERRAFORM ? it : it.skip;

/**
 * `moved`/`import` blocks make the synthesizer register a `terraform version`
 * check (`hasResourceMove()` / `importFrom` -> ValidateTerraformVersion), which
 * shells out to the binary. Offline, write the stack with validations skipped —
 * exactly what `new App({ skipValidation: true })` does for `cdktf synth`.
 */
function fullSynthSkippingValidations(stack: TerraformStack): string {
  const outdir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cdktf.outdir.'));
  const manifest = new Manifest('stubbed', outdir, false);
  stack.synthesizer.synthesize({ outdir, manifest, skipValidation: true });
  manifest.writeToFile();
  return outdir;
}

/** True when `terraform` (or `$TERRAFORM_BINARY_NAME`, e.g. `tofu`) is on PATH — the cdktf version validation shells out to it. */
function terraformOnPath(): boolean {
  try {
    require('node:child_process').execSync(`${process.env.TERRAFORM_BINARY_NAME ?? 'terraform'} version`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const PROPS = { tier: 'dev', project: 'demo', region: 'us-central1' } as const;

describe('10 · OverridesStack: the escape-hatch ladder', () => {
  const json = () => JSON.parse(Testing.synth(new OverridesStack(Testing.app(), 'm10-overrides', PROPS)));

  test('addOverride: nested key (object) vs list index (array), lifecycle list append', () => {
    const api = json().resource.google_cloud_run_v2_service.Api;
    expect(api.template.containers[0].image).toBe('us-docker.pkg.dev/cloudrun/container/hello:latest'); // list index override replaced the value
    expect(api.template.scaling).toEqual({ min_instance_count: 0 }); // nested key created under the single block `template`
    expect(api.lifecycle.ignore_changes).toEqual(['client', 'client_version']);
    expect(Object.keys(api.template)).not.toContain('0'); // no bogus index on a single block
  });

  test('Fn.rawString escapes ${} so Cloud Run sees the literal ${PORT}', () => {
    const api = json().resource.google_cloud_run_v2_service.Api;
    expect(api.template.containers[0].env[0]).toEqual({ name: 'LISTEN', value: '0.0.0.0:$${PORT}' });
  });

  test('overrideLogicalId changes the Terraform address; references follow', () => {
    const j = json();
    expect(j.resource.google_sql_database_instance.main).toBeDefined();
    expect(j.resource.google_sql_database_instance.OrdersDb).toBeUndefined();
    expect(j.resource.google_sql_database_instance.main.settings).toEqual({ tier: 'db-f1-micro', deletion_protection_enabled: false });
    expect(j.resource.google_some_new_thing.NewThing.instance).toBe('${google_sql_database_instance.main.name}');
    expect(j.resource.google_some_new_thing.NewThing.depends_on).toEqual(['google_sql_database_instance.main']);
  });

  test('raw TerraformResource renders an unknown type with overrides and joins required_providers', () => {
    const j = json();
    expect(j.resource.google_some_new_thing.NewThing).toEqual({
      name: 'cdkm-hatch-dev-thing',
      instance: '${google_sql_database_instance.main.name}',
      settings: { mode: 'FAST', replicas: 2 },
      depends_on: ['google_sql_database_instance.main'],
    });
    expect(j.terraform.required_providers.google).toEqual({ source: 'google', version: '6.50.0' });
    expect(j.output.ThingId.value).toBe('${google_some_new_thing.NewThing.id}');
  });

  test('provider-defined function call renders verbatim', () => {
    expect(json().output.DbProject.value).toBe('${provider::google::project_from_id(google_sql_database_instance.main.id)}');
  });

  test('prod tier flips the tier-driven overrides', () => {
    const j = JSON.parse(Testing.synth(new OverridesStack(Testing.app(), 'm10-overrides', { ...PROPS, tier: 'prod' })));
    expect(j.resource.google_cloud_run_v2_service.Api.template.scaling.min_instance_count).toBe(1);
    expect(j.resource.google_sql_database_instance.main.deletion_protection).toBe(true);
    expect(j.resource.google_storage_bucket.Logs.soft_delete_policy.retention_duration_seconds).toBe(604800);
  });
});

describe('10 · RefactorStack: import and moved blocks', () => {
  const json = () => JSON.parse(Testing.synth(new RefactorStack(Testing.app(), 'm10-refactor', PROPS)));

  test('importFrom renders a top-level import block', () => {
    expect(json().import).toEqual(expect.arrayContaining([{ id: 'projects/demo/buckets/cdkm-refactor-dev-adopted', to: 'google_storage_bucket.Adopted' }]));
  });

  test('addMoveTarget/moveTo: the old resource disappears from the config and a moved block appears', () => {
    const j = json();
    expect(j.resource.google_pubsub_topic.Renamed).toBeDefined();
    expect(j.resource.google_pubsub_topic.OrdersEvents).toBeUndefined();
    expect(j.moved).toEqual(expect.arrayContaining([{ from: 'google_pubsub_topic.OrdersEvents', to: 'google_pubsub_topic.Renamed' }]));
  });

  test('moveFromId names a legacy address that no longer exists in code', () => {
    expect(json().moved).toEqual(expect.arrayContaining([{ from: 'google_service_account.legacy_reader', to: 'google_service_account.Reader' }]));
    expect(json().moved).toHaveLength(2);
  });

  test('moved/import blocks register a `terraform version` validation: fullSynth needs the binary', () => {
    const fullSynth = () => Testing.fullSynth(new RefactorStack(Testing.app(), 'm10-refactor', PROPS));
    if (terraformOnPath()) expect(fullSynth).not.toThrow();
    else expect(fullSynth).toThrow(/Could not determine version of terraform/);
    // Either way, skipping validations writes the blocks:
    const outdir = fullSynthSkippingValidations(new RefactorStack(Testing.app(), 'm10-refactor', PROPS));
    const cdkTf = JSON.parse(fs.readFileSync(path.join(outdir, 'stacks', 'm10-refactor', 'cdk.tf.json'), 'utf8'));
    expect(cdkTf.moved).toHaveLength(2);
    expect(cdkTf.import).toHaveLength(1);
  });

  itIfTerraform('with a terraform binary the validation passes (>= 1.5 required)', () => {
    expect(() => Testing.fullSynth(new RefactorStack(Testing.app(), 'm10-refactor', PROPS))).not.toThrow();
  });
});

describe('10 · InteropStack: remote state, registry module, asset, variable', () => {
  const stack = () => new InteropStack(Testing.app(), 'm10-interop', { ...PROPS, assetHash: 'PINNED' });

  test('DataTerraformRemoteStateGcs consumes a legacy output', () => {
    const j = JSON.parse(Testing.synth(stack()));
    expect(j.data.terraform_remote_state.Legacy).toEqual({ backend: 'gcs', config: { bucket: 'cdkm-tf-state', prefix: 'legacy/assets' } });
    expect(j.resource.google_storage_bucket_iam_member.LegacyBucketReader.bucket).toBe('${data.terraform_remote_state.Legacy.outputs.assets_bucket}');
    expect(j.resource.google_storage_bucket_iam_member.LegacyBucketReader.member).toBe('${var.dataset_owner}');
  });

  test('TerraformHclModule renders a module block and its outputs are addressable', () => {
    const j = JSON.parse(Testing.synth(stack()));
    expect(j.module.Network).toMatchObject({ source: 'terraform-google-modules/network/google', version: '~> 10.0', project_id: 'demo', routing_mode: 'GLOBAL' });
    expect(j.module.Network.subnets[0].subnet_ip).toBe('10.50.0.0/20');
    expect(j.output.NetworkSelfLink.value).toBe('${module.Network.network_self_link}');
  });

  test('TerraformAsset: file asset path is content-hashed unless pinned; file() reads it at plan time', () => {
    const j = JSON.parse(Testing.synth(stack()));
    expect(j.resource.google_bigquery_table.Orders.schema).toBe('${jsonencode(jsondecode(file("assets/OrdersSchema/PINNED/orders.json")))}');
    expect(j.resource.google_storage_bucket_object.SchemaCopy.source).toBe('assets/OrdersSchema/PINNED/orders.json');
    const unpinned = JSON.parse(Testing.synth(new InteropStack(Testing.app(), 'm10-interop', PROPS)));
    expect(unpinned.resource.google_storage_bucket_object.SchemaCopy.source).toMatch(/^assets\/OrdersSchema\/[0-9A-F]{32}\/orders\.json$/);
    const outdir = Testing.fullSynth(stack());
    expect(fs.existsSync(path.join(outdir, 'stacks', 'm10-interop', 'assets', 'OrdersSchema', 'PINNED', 'orders.json'))).toBe(true);
  });

  test('a variable without a default is rendered and referenced as ${var.name}', () => {
    const j = JSON.parse(Testing.synth(stack()));
    expect(j.variable.dataset_owner).toEqual({ type: 'string', description: 'Email of the group that owns the analytics dataset (group:...)' });
    expect(j.variable.dataset_owner.default).toBeUndefined();
  });

  test('BigQuery table protection follows the tier', () => {
    expect(Testing.synth(stack())).toHaveResourceWithProperties(BigqueryTable, { deletion_protection: false });
    expect(Testing.synth(new InteropStack(Testing.app(), 'm10-interop', { ...PROPS, tier: 'prod' }))).toHaveResourceWithProperties(BigqueryTable, { deletion_protection: true });
  });
});

describe('10 · ConvertedStack: legacy/main.tf as CDKTF with pinned addresses', () => {
  test('addresses, variables, locals and outputs match the HCL names exactly', () => {
    const stack = new ConvertedStack(Testing.app(), 'm10-converted');
    const j = JSON.parse(Testing.synth(stack));
    expect(Object.keys(j.resource.google_storage_bucket)).toEqual(['assets']);
    expect(Object.keys(j.resource.google_service_account)).toEqual(['assets_reader']);
    expect(Object.keys(j.resource.google_storage_bucket_iam_member)).toEqual(['reader']);
    expect(Object.keys(j.variable).sort()).toEqual(['environment', 'project_id']);
    expect(Object.keys(j.output).sort()).toEqual(['assets_bucket', 'reader_email']);
    expect(j.locals.labels).toEqual({ environment: '${var.environment}', 'managed-by': 'terraform' });
    expect(j.resource.google_storage_bucket.assets).toMatchObject({
      name: 'cdkm-legacy-assets-${var.environment}',
      labels: '${local.labels}',
      lifecycle_rule: [{ action: { type: 'Delete' }, condition: { num_newer_versions: 5 } }],
      versioning: { enabled: true },
    });
    expect(j.resource.google_storage_bucket_iam_member.reader.member).toBe('serviceAccount:${google_service_account.assets_reader.email}');
    expect(j.variable.environment.validation[0].condition).toBe('${contains(["dev", "staging", "prod"], var.environment)}');
    expect(j.provider.google[0]).toEqual({ project: '${var.project_id}', region: 'us-central1' });
  });

  test('the backend from the HCL is kept only on request', () => {
    expect(JSON.parse(Testing.synth(new ConvertedStack(Testing.app(), 'm10-converted'))).terraform.backend).toBeUndefined();
    expect(JSON.parse(Testing.synth(new ConvertedStack(Testing.app(), 'm10-converted', { keepBackend: true }))).terraform.backend).toEqual({ gcs: { bucket: 'cdkm-tf-state', prefix: 'legacy/assets' } });
  });

  test('legacy/main.tf declares exactly the resources converted.ts pins', () => {
    const hcl = fs.readFileSync(path.resolve(__dirname, '../src/modules/10-escape-hatches-hcl-migration-and-interop/legacy/main.tf'), 'utf8');
    const declared = [...hcl.matchAll(/^resource "(\w+)" "(\w+)"/gm)].map((m) => `${m[1]}.${m[2]}`).sort();
    const j = JSON.parse(Testing.synth(new ConvertedStack(Testing.app(), 'm10-converted')));
    const rendered = Object.entries<Record<string, unknown>>(j.resource).flatMap(([type, instances]) => Object.keys(instances).map((id) => `${type}.${id}`)).sort();
    expect(rendered).toEqual(declared);
    expect([...hcl.matchAll(/^variable "(\w+)"/gm)].map((m) => m[1]).sort()).toEqual(Object.keys(j.variable).sort());
    expect([...hcl.matchAll(/^output "(\w+)"/gm)].map((m) => m[1]).sort()).toEqual(Object.keys(j.output).sort());
  });

  test('cdktf synth --hcl: the same stack renders as HCL for an HCL-only team', () => {
    const hcl: string = Testing.synthHcl(new ConvertedStack(Testing.app(), 'm10-converted'));
    expect(hcl).toContain('resource "google_storage_bucket" "assets" {');
    expect(hcl).toContain('variable "project_id" {');
    expect(hcl).toContain('output "assets_bucket" {');
    expect(hcl).toContain('member = "serviceAccount:${google_service_account.assets_reader.email}"');
  });

  test('every stack synthesizes fully', () => {
    expect(() => Testing.fullSynth(new OverridesStack(Testing.app(), 'm10-overrides', PROPS))).not.toThrow();
    expect(() => Testing.fullSynth(new ConvertedStack(Testing.app(), 'm10-converted'))).not.toThrow();
  });
});

describe('10 · exercise solutions', () => {
  test('1. importId knows the id format per type; adopt() wires importFrom', () => {
    const stack = new TerraformStack(Testing.app(), 'adopt');
    new GoogleProvider(stack, 'Google', { project: 'demo' });
    const bucket = adopt(new StorageBucket(stack, 'B', { name: 'b', location: 'US' }), 'b', { project: 'demo' });
    const sa = adopt(new ServiceAccount(stack, 'Sa', { accountId: 'x' }), 'x@demo.iam.gserviceaccount.com', { project: 'demo' });
    expect(importId(bucket, 'b', { project: 'demo' })).toBe('projects/demo/buckets/b');
    expect(importId(sa, 'x@demo.iam.gserviceaccount.com', { project: 'demo' })).toBe('projects/demo/serviceAccounts/x@demo.iam.gserviceaccount.com');
    expect(() => importId(new StorageBucketIamMember(stack, 'M', { bucket: 'b', role: 'r', member: 'm' }), 'x', { project: 'demo' })).toThrow(/no known id format/);
    const j = JSON.parse(Testing.synth(stack));
    expect(j.import).toEqual(expect.arrayContaining([
      { id: 'projects/demo/buckets/b', to: 'google_storage_bucket.B' },
      { id: 'projects/demo/serviceAccounts/x@demo.iam.gserviceaccount.com', to: 'google_service_account.Sa' },
    ]));
  });

  test('2. for_each conversion: iterator over a variable map, iterator over a resource, plucked output', () => {
    const j = JSON.parse(Testing.synth(new ConvertedForEachStack(Testing.app(), 'm10-foreach')));
    expect(j.resource.google_pubsub_topic.t).toEqual({ for_each: '${var.topics}', name: '${each.key}', message_retention_duration: '${each.value.retention}' });
    expect(j.resource.google_pubsub_subscription.s).toEqual({ for_each: '${google_pubsub_topic.t}', name: '${each.key}-sub', topic: '${each.value.name}' });
    expect(j.output.topic_ids.value).toBe('${{ for key, val in google_pubsub_topic.t: key => val.id }}');
    expect(j.variable.topics.type).toBe('map(object({ retention = string }))');
    expect(Testing.synth(new ConvertedForEachStack(Testing.app(), 'x'))).toHaveResource(PubsubTopic);
    expect(Testing.synth(new ConvertedForEachStack(Testing.app(), 'x'))).toHaveResource(PubsubSubscription);
  });

  test('3a. the trap: overrideLogicalId from an aspect is ignored for a resource whose attribute was already referenced', () => {
    const stack = new TerraformStack(Testing.app(), 'pins');
    new GoogleProvider(stack, 'Google', { project: 'demo' });
    const bucket = new StorageBucket(stack, 'Assets', { name: 'a', location: 'US' });
    new StorageBucketIamMember(stack, 'Reader', { bucket: bucket.name, role: 'roles/storage.objectViewer', member: 'group:x@example.com' });
    const aspect = new PinnedLogicalIdsAspect({ Assets: 'assets', Reader: 'reader' });
    Aspects.of(stack).add(aspect);
    const j = JSON.parse(Testing.synth(stack));
    expect(Object.keys(j.resource.google_storage_bucket)).toEqual(['Assets']); // NOT pinned: `bucket.name` froze the id
    expect(Object.keys(j.resource.google_storage_bucket_iam_member)).toEqual(['reader']); // pinned: nothing referenced it
    expect(aspect.lateForReferenced).toEqual(['Assets']);
  });

  test('3b. PinnedIdsStack overrides allocateLogicalId: pins apply regardless of reference order, nested paths included', () => {
    const stack = new PinnedIdsStack(Testing.app(), 'pins', { Assets: 'assets', 'Readers/Reader': 'reader', Typo: 'nope' });
    new GoogleProvider(stack, 'Google', { project: 'demo' });
    const bucket = new StorageBucket(stack, 'Assets', { name: 'a', location: 'US' });
    const scope = new (require('constructs').Construct)(stack, 'Readers');
    new StorageBucketIamMember(scope, 'Reader', { bucket: bucket.name, role: 'roles/storage.objectViewer', member: 'group:x@example.com' });
    const j = JSON.parse(Testing.synth(stack));
    expect(Object.keys(j.resource.google_storage_bucket)).toEqual(['assets']);
    expect(Object.keys(j.resource.google_storage_bucket_iam_member)).toEqual(['reader']);
    expect(j.resource.google_storage_bucket_iam_member.reader.bucket).toBe('${google_storage_bucket.assets.name}');
    expect(Object.keys(j.provider.google[0])).toEqual(['project']); // unpinned elements fall back to the default allocation
    expect(stack.unmatched()).toEqual(['Typo']);
  });
});
