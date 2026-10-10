import * as fs from 'fs';
import * as path from 'path';
import { Op, TerraformOutput, Testing, Token, ref } from 'cdktf';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { GoogleBetaProvider } from '@cdktf/provider-google-beta/lib/provider';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { ProjectService } from '@cdktf/provider-google/lib/project-service';
import { GooglePubsubTopic } from '@cdktf/provider-google-beta/lib/google-pubsub-topic';
import { DataGoogleComputeZones } from '@cdktf/provider-google/lib/data-google-compute-zones';
import { DataGoogleProject } from '@cdktf/provider-google/lib/data-google-project';
import { DEFAULT_BUCKETS, TokensStack, addToApp } from '../src/modules/01-providers-resources-and-tokens';
import { RegionalBucketsStack } from '../src/modules/01-providers-resources-and-tokens/solutions/01-list-iterator';
import { ValidatedBucketStack } from '../src/modules/01-providers-resources-and-tokens/solutions/02-validated-inputs';
import { EscapeHatchStack } from '../src/modules/01-providers-resources-and-tokens/solutions/03-escape-hatches';

Testing.setupJest();

describe('01 · providers', () => {
  const stack = new TokensStack(Testing.app(), 'm01-tokens', { tier: 'dev', buckets: DEFAULT_BUCKETS, project: 'proj' });
  const synth = Testing.synth(stack);
  const json = JSON.parse(synth);

  it('configures google with project/region/zone, billing project, user_project_override and request_reason', () => {
    expect(synth).toHaveProviderWithProperties(GoogleProvider, {
      project: 'proj',
      region: 'us-central1',
      zone: 'us-central1-a',
      billing_project: 'proj',
      user_project_override: true,
      request_reason: 'cdk-mastery',
    });
  });

  it('declares google-beta as an alias and routes the beta resource to it', () => {
    expect(synth).toHaveProviderWithProperties(GoogleBetaProvider, { alias: 'beta', project: 'proj' });
    expect(synth).toHaveResourceWithProperties(GooglePubsubTopic, { provider: 'google-beta.beta' });
    expect(json.terraform.required_providers['google-beta']).toEqual({ source: 'google-beta', version: '6.50.0' });
  });

  it('keeps hyphenated default_labels keys intact by writing them through addOverride', () => {
    // cdktf snake-cases provider config recursively; the override path is the fix.
    expect(json.provider.google[0].default_labels).toEqual({
      environment: 'dev',
      service: 'tokens',
      owner: 'platform-team',
      'cost-center': 'cc-platform-dev',
      'managed-by': 'cdk-mastery',
    });
    expect(json.provider['google-beta'][0].default_labels['cost-center']).toBe('cc-platform-dev');
  });

  it('passes impersonation through to both providers when set', () => {
    const s = Testing.synth(
      new TokensStack(Testing.app(), 'x', {
        tier: 'dev',
        buckets: DEFAULT_BUCKETS,
        impersonateServiceAccount: 'deployer@proj.iam.gserviceaccount.com',
      }),
    );
    expect(s).toHaveProviderWithProperties(GoogleProvider, { impersonate_service_account: 'deployer@proj.iam.gserviceaccount.com' });
    expect(s).toHaveProviderWithProperties(GoogleBetaProvider, { impersonate_service_account: 'deployer@proj.iam.gserviceaccount.com' });
  });
});

describe('01 · data sources and tokens', () => {
  const stack = new TokensStack(Testing.app(), 'm01-tokens', { tier: 'dev', buckets: DEFAULT_BUCKETS, project: 'proj' });
  const synth = Testing.synth(stack);
  const json = JSON.parse(synth);

  it('declares the three data sources; nested construct ids get a hash suffix', () => {
    expect(synth).toHaveDataSourceWithProperties(DataGoogleComputeZones, { region: 'us-central1', status: 'UP' });
    expect(synth).toHaveDataSource(DataGoogleProject);
    expect(Object.keys(json.data.google_project)[0]).toMatch(/^Facts_Project_[0-9A-F]{8}$/);
  });

  it('attribute accessors are unresolved tokens at synth time and different attributes render differently', () => {
    expect(Token.isUnresolved(stack.facts.projectNumber)).toBe(true);
    expect(Token.isUnresolved(stack.facts.firstZone)).toBe(true);
    expect(json.output.tiered_name.value).toBe('${google_storage_bucket.Tiered.name}');
    expect(json.output.tiered_id.value).toBe('${google_storage_bucket.Tiered.id}');
    expect(json.output.tiered_self_link.value).toBe('${google_storage_bucket.Tiered.self_link}');
  });

  it('template literals with tokens render as interpolations inside plain strings', () => {
    expect(json.output.tiered_export_uri.value).toBe('gs://${google_storage_bucket.Tiered.name}/exports/dev');
  });

  it('Fn.* and propertyAccess render Terraform function calls and splats', () => {
    expect(json.output.first_zone.value).toMatch(/^\$\{element\(data\.google_compute_zones\.Facts_Zones_[0-9A-F]{8}\.names, 0\)\}$/);
    expect(json.output.zone_count.value).toMatch(/^\$\{length\(data\.google_compute_zones\./);
    expect(json.output.first_subnet_cidr.value).toBe('${cidrsubnet("10.10.0.0/16", 8, 1)}');
    expect(json.output.bucket_names.value).toBe('${values(google_storage_bucket.Buckets)[*].name}');
    expect(json.output.raw_bucket_class.value).toBe('${lookup(lookup(local.bucket_specs, "raw", {}), "storageClass", "STANDARD")}');
    expect(json.output.audit_bucket_name.value).toBe('${one(google_storage_bucket.Audit[*].name)}');
    expect(json.output.bucket_policy_json.value).toContain('${jsonencode({');
    expect(json.output.bucket_policy_json.value).toContain('google_pubsub_topic.Events.id');
  });

  it('a naive .length on a list token is a bug the type system cannot catch', () => {
    // The token is an array with a single marker element, so .length is 1 regardless of the real list.
    expect(stack.facts.zoneNames.length).toBe(1);
    expect(Token.isUnresolved(stack.facts.zoneNames)).toBe(true);
    // The right way to ask is a Terraform function evaluated at plan time.
    expect(json.output.zone_count.value).toMatch(/^\$\{length\(/);
  });

  it('Op.* renders a falsy right operand as undefined (cdktf 0.21 quirk) — keep literals on the left', () => {
    const app = Testing.app();
    const s = new TokensStack(app, 'q', { tier: 'dev', buckets: DEFAULT_BUCKETS });
    new TerraformOutput(s, 'bad', { value: Op.eq(ref('var.audit_retention_days'), 0) });
    new TerraformOutput(s, 'good', { value: Op.eq(0, ref('var.audit_retention_days')) });
    // ...and plain strings are literals, escaped rather than interpreted:
    new TerraformOutput(s, 'literal', { value: Op.eq(0, '${var.audit_retention_days}') });
    const out = JSON.parse(Testing.synth(s)).output;
    expect(out.bad.value).toBe('${(var.audit_retention_days == undefined)}');
    expect(out.good.value).toBe('${(0 == var.audit_retention_days)}');
    expect(out.literal.value).toBe('${(0 == "$${var.audit_retention_days}")}');
  });
});

describe('01 · variables, locals, outputs', () => {
  const json = JSON.parse(Testing.synth(new TokensStack(Testing.app(), 'x', { tier: 'dev', buckets: DEFAULT_BUCKETS })));

  it('emits typed variables with defaults, sensitivity and validation blocks', () => {
    expect(json.variable.bucket_prefix).toMatchObject({ type: 'string', default: 'cdkm' });
    expect(json.variable.bucket_prefix.validation[0].condition).toBe('${can(regex("^[a-z][a-z0-9-]{1,20}$", var.bucket_prefix))}');
    expect(json.variable.enable_audit_bucket).toMatchObject({ type: 'bool', default: false });
    expect(json.variable.audit_retention_days.validation[0].condition).toBe('${(var.audit_retention_days >= 1)}');
    expect(json.variable.audit_reader.sensitive).toBe(true);
    expect(json.variable.archive_transitions.type).toBe('list(object({age=number, storage_class=string}))');
  });

  it('locals are expressions; the sensitive output is flagged', () => {
    expect(json.locals.name_prefix).toBe('${format("%s-%s", var.bucket_prefix, "dev")}');
    expect(json.locals.common_labels).toMatchObject({ environment: 'dev', service: 'tokens' });
    expect(json.output.audit_reader_principal).toEqual({ value: '${var.audit_reader}', sensitive: true });
  });
});

describe('01 · meta-arguments', () => {
  const dev = JSON.parse(Testing.synth(new TokensStack(Testing.app(), 'x', { tier: 'dev', buckets: DEFAULT_BUCKETS })));
  const prod = JSON.parse(Testing.synth(new TokensStack(Testing.app(), 'x', { tier: 'prod', buckets: DEFAULT_BUCKETS })));
  const buckets = dev.resource.google_storage_bucket;

  it('for_each over the map: one block, each.key/each.value in name, labels and lifecycle rule', () => {
    expect(buckets.Buckets.for_each).toEqual(DEFAULT_BUCKETS);
    expect(buckets.Buckets.name).toBe('${format("%s-%s", local.name_prefix, each.key)}');
    expect(buckets.Buckets.storage_class).toBe('${each.value.storageClass}');
    expect(buckets.Buckets.labels).toBe('${merge(local.common_labels, {"purpose" = each.value.purpose, "key" = each.key})}');
    expect(buckets.Buckets.lifecycle_rule).toEqual([{ action: { type: 'Delete' }, condition: { age: '${each.value.retentionDays}' } }]);
  });

  it('conditional resource: count is a ternary on the bool variable', () => {
    expect(buckets.Audit.count).toBe('${var.enable_audit_bucket ? 1 : 0}');
  });

  it('dynamic block: lifecycle_rule generated from the list variable with its own iterator', () => {
    expect(buckets.Tiered.dynamic.lifecycle_rule).toEqual({
      for_each: '${toset(var.archive_transitions)}',
      iterator: 'each',
      content: {
        action: { type: 'SetStorageClass', storageClass: '${each.value.storage_class}' },
        condition: { age: '${each.value.age}' },
      },
    });
    expect(buckets.Tiered.lifecycle_rule).toBeUndefined();
  });

  it('depends_on renders resource addresses; the API enablement never disables on destroy', () => {
    expect(buckets.Buckets.depends_on).toEqual(['google_project_service.StorageApi']);
    expect(Testing.synth(new TokensStack(Testing.app(), 'x', { tier: 'dev', buckets: DEFAULT_BUCKETS }))).toHaveResourceWithProperties(
      ProjectService,
      { service: 'storage.googleapis.com', disable_on_destroy: false },
    );
  });

  it('lifecycle: prevent_destroy follows the tier, ignore_changes and precondition are emitted', () => {
    expect(buckets.Audit.lifecycle).toEqual({
      prevent_destroy: false,
      ignore_changes: ['labels'],
      precondition: [
        {
          condition: '${(!var.enable_audit_bucket || (var.audit_retention_days >= 365))}',
          error_message: 'Audit buckets must retain objects for at least 365 days.',
        },
      ],
    });
    expect(prod.resource.google_storage_bucket.Audit.lifecycle.prevent_destroy).toBe(true);
    expect(prod.resource.google_storage_bucket.Audit.retention_policy.is_locked).toBe(true);
  });

  it('create_before_destroy on the random suffix, keepers bind it to inputs', () => {
    expect(dev.resource.random_id.Suffix).toEqual({
      byte_length: 2,
      keepers: { tier: 'dev', prefix: '${var.bucket_prefix}' },
      lifecycle: { create_before_destroy: true },
    });
    expect(buckets.Tiered.name).toBe('${local.name_prefix}-tiered-${random_id.Suffix.hex}');
  });

  it('addOverride writes raw JSON the typed lifecycle cannot express', () => {
    expect(dev.resource.google_pubsub_topic.Events.lifecycle).toEqual({ ignore_changes: ['labels["last-published"]'] });
  });

  it('TypeScript validation fires before any Terraform is produced', () => {
    expect(
      () =>
        new TokensStack(Testing.app(), 'x', {
          tier: 'dev',
          buckets: { bad: { storageClass: 'STANDARD', retentionDays: 0, purpose: 'x' } },
        }),
    ).toThrow(/buckets\.bad\.retentionDays/);
  });

  it('full synth succeeds', () => {
    const outdir = Testing.fullSynth(new TokensStack(Testing.app(), 'm01-tokens', { tier: 'dev', buckets: DEFAULT_BUCKETS }));
    expect(fs.existsSync(path.join(outdir, 'stacks', 'm01-tokens', 'cdk.tf.json'))).toBe(true);
    fs.rmSync(outdir, { recursive: true, force: true });
  });
});

describe('01 · addToApp', () => {
  it('registers m01-tokens', () => {
    const app = Testing.app();
    addToApp(app);
    expect(app.node.children.map((c) => c.node.id)).toEqual(['m01-tokens']);
  });
});

describe('01 · exercise solutions', () => {
  it('1: fromList → toset for_each keyed by value; count → positional addresses', () => {
    const json = JSON.parse(
      Testing.synth(new RegionalBucketsStack(Testing.app(), 'x', { tier: 'dev', regions: ['us-central1', 'europe-west1'], shards: 3 })),
    );
    const b = json.resource.google_storage_bucket;
    expect(b.PerRegion.for_each).toBe('${toset(["us-central1", "europe-west1"])}');
    expect(b.PerRegion.location).toBe('${each.value}');
    expect(b.PerRegion.name).toBe('${format("%s-%s", "cdkm-tokens-dev-regional", replace(each.value, "-", ""))}');
    expect(b.Shard.count).toBe(3);
    expect(b.Shard.name).toBe('${format("%s-%d", "cdkm-tokens-dev-shard", count.index)}');
    expect(json.output.shard_bucket_names.value).toBe('${google_storage_bucket.Shard[*].name}');
    expect(json.output.region_short_codes.value).toBe('${join(",", ["usc1", "euw1"])}');
  });

  it('2: the same rule enforced in TypeScript, in variable validation and in pre/postconditions', () => {
    expect(
      () => new ValidatedBucketStack(Testing.app(), 'x', { tier: 'dev', location: 'ASIA', allowedLocations: ['US', 'EU'] }),
    ).toThrow(/not in allowedLocations/);

    const json = JSON.parse(
      Testing.synth(new ValidatedBucketStack(Testing.app(), 'x', { tier: 'dev', location: 'EU', allowedLocations: ['US', 'EU'] })),
    );
    expect(json.variable.allowed_locations.validation).toEqual([
      { condition: '${(0 == length(setsubtract(var.allowed_locations, ["US", "EU"])))}', error_message: 'allowed_locations may only contain: US, EU' },
      { condition: '${(length(var.allowed_locations) >= 1)}', error_message: 'allowed_locations must not be empty.' },
    ]);
    const bucket = json.resource.google_storage_bucket.Bucket;
    expect(bucket.lifecycle.precondition[0].condition).toBe('${contains(var.allowed_locations, "EU")}');
    expect(bucket.lifecycle.postcondition[0].condition).toBe('${(self.project_number >= 1)}');

  });

  it('3: overrideLogicalId keeps the legacy address, importFrom emits an import block, raw TerraformResource works', () => {
    const stack = new EscapeHatchStack(Testing.app(), 'x', { existingBucketName: 'legacy-bucket', project: 'proj' });
    const json = JSON.parse(Testing.synth(stack));
    expect(Object.keys(json.resource.google_storage_bucket)).toEqual(['legacy']);
    expect(json.resource.google_storage_bucket.legacy).toMatchObject({ name: 'legacy-bucket', rpo: 'DEFAULT', timeouts: { create: '10m' } });
    expect(json.import).toEqual([{ id: 'legacy-bucket', to: 'google_storage_bucket.legacy', provider: 'google' }]);
    expect(json.resource.google_storage_notification.Notification).toMatchObject({
      bucket: '${google_storage_bucket.legacy.name}',
      payload_format: 'JSON_API_V1',
      depends_on: ['google_storage_bucket.legacy'],
    });
    expect(json.output.notification_id.value).toBe('${google_storage_notification.Notification.notification_id}');
    expect(Testing.synth(stack)).toHaveResourceWithProperties(StorageBucket, { name: 'legacy-bucket' });
  });
});
