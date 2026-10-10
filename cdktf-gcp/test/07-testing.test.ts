/**
 * 07 · Testing — this file IS the module. Every section corresponds to a rung
 * of the testing pyramid in the README. Read top to bottom.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Aspects, TerraformOutput, TerraformStack, TerraformVariable, Testing } from 'cdktf';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { DataGoogleProject } from '@cdktf/provider-google/lib/data-google-project';
import { PubsubSubscription } from '@cdktf/provider-google/lib/pubsub-subscription';
import { PubsubTopic } from '@cdktf/provider-google/lib/pubsub-topic';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { StorageBucketIamMember } from '@cdktf/provider-google/lib/storage-bucket-iam-member';
import { StorageBucketObject } from '@cdktf/provider-google/lib/storage-bucket-object';
import { SqlDatabaseInstance } from '@cdktf/provider-google/lib/sql-database-instance';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import { MinimumRetentionAspect, NoTodoDescriptionsAspect, PrivateBucket, TestableStack, stabilise } from '../src/modules/07-testing';
import { countDataSources, countResources, logicalIds, resourceInventory } from '../src/modules/07-testing/solutions/count-resources';
import { cdkmMatchers } from '../src/modules/07-testing/solutions/custom-matchers';
import { compareTiers, get, synthAllEnvironments } from '../src/modules/07-testing/solutions/env-matrix';

// The adapter import in test/setup.ts only provides *types*; registration is explicit.
Testing.setupJest();
expect.extend(cdkmMatchers);

// Gate the rungs that need a Terraform binary and registry access.
const itIfTerraform = process.env.CDKM_TERRAFORM ? it : it.skip;

/** A fresh prod stack per test: tests must not share construct trees. */
function prodStack(overrides: Partial<ConstructorParameters<typeof TestableStack>[2]> = {}) {
  const app = Testing.app();
  return new TestableStack(app, 'm07-testable-prod', { tier: 'prod', project: 'demo', region: 'us-central1', assetHash: 'PINNED', ...overrides });
}

describe('07 · rung 1: unit tests on constructs (Testing.synthScope)', () => {
  test('PrivateBucket applies its defaults and one iam_member per reader', () => {
    const synth = Testing.synthScope((scope) => {
      new PrivateBucket(scope, 'Logs', { name: 'logs', location: 'US', readers: ['group:sec@example.com', 'serviceAccount:x@p.iam.gserviceaccount.com'] });
    });
    expect(synth).toHaveResourceWithProperties(StorageBucket, {
      name: 'logs',
      uniform_bucket_level_access: true,
      public_access_prevention: 'enforced',
      versioning: { enabled: true },
    });
    expect(synth).toHaveResourceWithProperties(StorageBucketIamMember, { member: 'group:sec@example.com', role: 'roles/storage.objectViewer' });
    expect(countResources(synth, 'google_storage_bucket_iam_member')).toBe(2);
    // The construct's own contract, no aspect involved:
  });

  test('PrivateBucket rejects public principals at construction time', () => {
    expect(() =>
      Testing.synthScope((scope) => {
        new PrivateBucket(scope, 'Bad', { name: 'x', location: 'US', readers: ['allUsers'] });
      }),
    ).toThrow(/public principals are not allowed as readers \(allUsers\)/);
  });

  test('with the jest adapter, matcher keys must be snake_case (as rendered) and match a SUBSET of properties', () => {
    const synth = Testing.synthScope((scope) => new PrivateBucket(scope, 'B', { name: 'b', location: 'EU' }));
    expect(synth).toHaveResourceWithProperties(StorageBucket, { uniform_bucket_level_access: true });
    // The jest adapter evaluates with expect.objectContaining, which does NOT
    // translate camelCase; only the non-jest `Testing.toHaveResourceWithProperties` does.
    expect(synth).not.toHaveResourceWithProperties(StorageBucket, { uniformBucketLevelAccess: true });
    expect(Testing.toHaveResourceWithProperties(synth, StorageBucket.tfResourceType, { uniformBucketLevelAccess: true })).toBe(true);
    expect(synth).not.toHaveResourceWithProperties(StorageBucket, { location: 'US' });
    // objectContaining is recursive for plain objects: a nested subset matches.
    expect(synth).toHaveResourceWithProperties(StorageBucket, { versioning: { enabled: true } });
    expect(synth).toHaveResourceWithProperties(StorageBucket, { versioning: expect.objectContaining({}) });
  });
});

describe('07 · rung 2: stack-level assertions (Testing.app + Testing.synth)', () => {
  test('provider, data source and resources are present', () => {
    const synth = Testing.synth(prodStack());
    expect(synth).toHaveProvider(GoogleProvider);
    expect(synth).toHaveProviderWithProperties(GoogleProvider, { project: 'demo', region: 'us-central1' });
    expect(synth).toHaveDataSource(DataGoogleProject);
    expect(synth).toHaveDataSourceWithProperties(DataGoogleProject, { project_id: 'demo' });
    expect(synth).toHaveResource(ServiceAccount);
    expect(synth).toHaveResource(StorageBucketObject);
    expect(synth).toHaveResourceWithProperties(PubsubTopic, { name: 'cdkm-testable-prod-orders', message_retention_duration: '604800s' });
    expect(synth).toHaveResourceWithProperties(PubsubSubscription, {
      dead_letter_policy: { dead_letter_topic: '${google_pubsub_topic.DeadLetter.id}', max_delivery_attempts: '${var.max_delivery_attempts}' },
    });
  });

  test('hand assertions on JSON.parse(synth): counts, depends_on, lifecycle, backend, outputs', () => {
    const stack = prodStack({ stateBucket: 'tf-state-demo' });
    const json = JSON.parse(Testing.synth(stack));

    // counts
    expect(Object.keys(json.resource.google_pubsub_topic)).toHaveLength(2);
    expect(countResources(Testing.synth(stack), 'google_pubsub_topic')).toBe(2);

    // depends_on renders as Terraform addresses
    expect(json.resource.google_pubsub_subscription.OrdersSub.depends_on).toEqual(['google_service_account.Worker']);

    // lifecycle
    expect(json.resource.google_pubsub_topic.Orders.lifecycle).toEqual({ ignore_changes: ['labels'] });

    // backend — conditional on props.stateBucket
    expect(json.terraform.backend).toEqual({ gcs: { bucket: 'tf-state-demo', prefix: 'cdk-mastery/m07-testable-prod' } });
    const local = JSON.parse(Testing.synth(prodStack()));
    expect(local.terraform.backend).toBeUndefined(); // Testing.synth does not add the default local backend; fullSynth/prepareStack do

    // outputs
    expect(json.output.TopicName).toEqual({ value: '${google_pubsub_topic.Orders.name}' });
    expect(json.output.ProjectNumber).toEqual({ value: '${data.google_project.Current.number}', sensitive: true });

    // interpolation shape of a cross-resource reference between nested constructs
    const [memberId] = Object.keys(json.resource.google_storage_bucket_iam_member);
    const [bucketId] = Object.keys(json.resource.google_storage_bucket);
    expect(memberId).toMatch(/^Artifacts_Reader0_[0-9A-F]{8}$/);
    expect(json.resource.google_storage_bucket_iam_member[memberId].bucket).toBe(`\${google_storage_bucket.${bucketId}.name}`);
  });

  test('logical ids of nested constructs are <path>_<hash>; top-level ids are verbatim', () => {
    const synth = Testing.synth(prodStack());
    expect(logicalIds(synth, 'google_pubsub_topic')).toEqual(['DeadLetter', 'Orders']);
    expect(logicalIds(synth, 'google_storage_bucket')).toEqual(['Artifacts_Bucket_ADA78AEC']); // stable: hash of the construct path
  });

  test('TerraformVariable defaults and outputs', () => {
    const synth = Testing.synth(prodStack());
    const json = JSON.parse(synth);
    expect(json.variable.max_delivery_attempts).toEqual({ type: 'number', default: 5, description: 'Deliveries before a message is dead-lettered' });
    expect(synth).toHaveVariableWithDefault('max_delivery_attempts', 5);
    expect(synth).toHaveOutput('TopicName');
    expect(synth).toHaveOutput('ProjectNumber', { sensitive: true });
    expect(synth).not.toHaveOutput('Missing');
    expect(synth).not.toHaveBackend('local'); // Testing.synth never adds the default backend (prepareStack does)
  });

  test('tier-driven differences: dev vs prod', () => {
    const dev = JSON.parse(Testing.synth(new TestableStack(Testing.app(), 'm07-testable-dev', { tier: 'dev', project: 'demo', assetHash: 'PINNED' })));
    const prod = JSON.parse(Testing.synth(prodStack()));
    expect(dev.resource.google_pubsub_topic.Orders.message_retention_duration).toBe('86400s');
    expect(prod.resource.google_pubsub_topic.Orders.message_retention_duration).toBe('604800s');
    expect(dev.resource.google_pubsub_topic.Orders.labels.environment).toBe('dev');
    expect(prod.resource.google_pubsub_topic.Orders.labels['cost-center']).toBe('cc-platform-prod');
  });
});

describe('07 · rung 3: snapshots (only where the README argues for them)', () => {
  test('stabilised snapshot of the whole stack: asset hash, backend path and provider version neutralised', () => {
    // No assetHash pin here on purpose: the stabiliser must handle the real hash.
    const app = Testing.app();
    const stack = new TestableStack(app, 'm07-testable-prod', { tier: 'prod', project: 'demo', region: 'us-central1' });
    stack.prepareStack(); // adds the default local backend, whose path contains process.cwd()
    const raw = Testing.synth(stack);
    expect(raw).toMatch(/assets\/ConfigAsset\/[0-9A-F]{32}\/archive\.zip/);
    expect(raw).toContain(process.cwd());
    const stable = stabilise(raw);
    expect(JSON.stringify(stable)).not.toContain(process.cwd());
    expect((stable as any).resource.google_storage_bucket_object.ConfigObject.source).toBe('assets/ConfigAsset/<hash>/archive.zip');
    expect((stable as any).terraform.required_providers.google.version).toBe('<version>');
    expect(stable).toMatchSnapshot();
  });

  test('pinning assetHash is the alternative when only the asset path is volatile', () => {
    const json = JSON.parse(Testing.synth(prodStack({ assetHash: 'PINNED' })));
    expect(json.resource.google_storage_bucket_object.ConfigObject.source).toBe('assets/ConfigAsset/PINNED/archive.zip');
  });

  test('inline snapshot of the resource inventory: cheap, readable, reviewable', () => {
    expect(resourceInventory(Testing.synth(prodStack()))).toMatchInlineSnapshot(`
{
  "google_pubsub_subscription": 1,
  "google_pubsub_topic": 2,
  "google_service_account": 1,
  "google_storage_bucket": 1,
  "google_storage_bucket_iam_member": 1,
  "google_storage_bucket_object": 1,
}
`);
    expect(countDataSources(Testing.synth(prodStack()), 'google_project')).toBe(1);
  });
});

describe('07 · testing aspects', () => {
  test('mutating aspect: assert the mutation happened in the synthesized output', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'asp');
    new GoogleProvider(stack, 'Google', { project: 'demo' });
    new PubsubTopic(stack, 'Short', { name: 'short', messageRetentionDuration: '600s' });
    new PubsubTopic(stack, 'Long', { name: 'long', messageRetentionDuration: '2592000s' });
    new PubsubTopic(stack, 'Unset', { name: 'unset' });
    Aspects.of(stack).add(new MinimumRetentionAspect(604800));
    const synth = Testing.synth(stack);
    expect(synth).toHaveResourceWithProperties(PubsubTopic, { name: 'short', message_retention_duration: '604800s' });
    expect(synth).toHaveResourceWithProperties(PubsubTopic, { name: 'long', message_retention_duration: '2592000s' });
    expect(synth).toHaveResourceWithProperties(PubsubTopic, { name: 'unset', message_retention_duration: '604800s' });
  });

  test('validating aspect: Testing.synth records the error, Testing.fullSynth aborts synthesis', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'todo');
    new GoogleProvider(stack, 'Google', { project: 'demo' });
    const sa = new ServiceAccount(stack, 'Sa', { accountId: 'sa', description: 'TODO: narrow the roles' });
    Aspects.of(stack).add(new NoTodoDescriptionsAspect());

    expect(() => Testing.synth(stack)).not.toThrow();
    const errors = sa.node.metadata.filter((m) => m.type === '@cdktf/error').map((m) => m.data);
    expect(errors).toEqual(['google_service_account description contains TODO: "TODO: narrow the roles"']);

    expect(() => Testing.fullSynth(stack)).toThrow(/Encountered Annotations with level "ERROR":\n\[todo\/Sa\] google_service_account description contains TODO/);
  });

  test('an aspect applied at the App level is never invoked (cdktf 0.21 starts traversal at the stack)', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'app-level');
    new GoogleProvider(stack, 'Google', { project: 'demo' });
    new PubsubTopic(stack, 'T', { name: 't', messageRetentionDuration: '600s' });
    Aspects.of(app).add(new MinimumRetentionAspect(604800));
    expect(Testing.synth(stack)).toHaveResourceWithProperties(PubsubTopic, { message_retention_duration: '600s' });
  });
});

describe('07 · rung 4: full synth to disk (Testing.fullSynth)', () => {
  test('writes manifest.json, cdk.tf.json and the asset archive into a temp dir', () => {
    const outdir = Testing.fullSynth(prodStack({ assetHash: 'PINNED' }));
    const manifest = JSON.parse(fs.readFileSync(path.join(outdir, 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe('stubbed');
    expect(Object.keys(manifest.stacks)).toEqual(['m07-testable-prod']);
    const stackDir = path.join(outdir, manifest.stacks['m07-testable-prod'].workingDirectory);
    const cdkTf = JSON.parse(fs.readFileSync(path.join(stackDir, 'cdk.tf.json'), 'utf8'));
    expect(cdkTf['//'].metadata.stackName).toBe('m07-testable-prod'); // metadata survives fullSynth (Testing.synth strips it)
    // fullSynth runs the synthesizer but NOT prepareStack(), so unlike `cdktf synth`
    // there is no default local backend and no cross-stack wiring. Call
    // stack.prepareStack() yourself when a test depends on either.
    expect(cdkTf.terraform.backend).toBeUndefined();
    expect(fs.existsSync(path.join(stackDir, 'assets', 'ConfigAsset', 'PINNED', 'archive.zip'))).toBe(true);
  });

  test('every stack in this module synthesizes fully for every tier', () => {
    for (const tier of Object.keys(ENVIRONMENTS)) {
      const app = Testing.app();
      expect(() => Testing.fullSynth(new TestableStack(app, `m07-testable-${tier}`, { tier, project: 'demo' }))).not.toThrow();
    }
  });
});

describe('07 · rungs 5 and 6: validate and plan (need a terraform binary; gated by CDKM_TERRAFORM)', () => {
  itIfTerraform('toBeValidTerraform runs `terraform init` + `validate` in the synthesized directory', () => {
    expect(Testing.fullSynth(prodStack())).toBeValidTerraform();
  });

  itIfTerraform('toPlanSuccessfully runs `terraform plan` (needs credentials for data sources)', () => {
    expect(Testing.fullSynth(prodStack())).toPlanSuccessfully();
  });
});

describe('07 · exercise solutions', () => {
  test('1. counting helpers', () => {
    const synth = Testing.synth(prodStack());
    expect(countResources(synth, 'google_pubsub_topic')).toBe(2);
    expect(countResources(synth, 'google_sql_database_instance')).toBe(0);
    expect(logicalIds(synth, 'google_pubsub_topic')).toEqual(['DeadLetter', 'Orders']);
  });

  test('2. custom matchers, including the negative paths', () => {
    const synth = Testing.synth(prodStack({ stateBucket: 'b' }));
    expect(synth).toHaveBackend('gcs', { bucket: 'b' });
    expect(synth).not.toHaveBackend('gcs', { bucket: 'other' });
    expect(synth).toHaveNoResource(SqlDatabaseInstance);
    expect(synth).not.toHaveNoResource(PubsubTopic);
    expect(() => expect(synth).toHaveOutput('Nope')).toThrow(/expected output "Nope"/);
    expect(() => expect('not json').toHaveOutput('x')).toThrow(/Testing\.synth/);
  });

  test('3. environment matrix: assert tier differences in one place', () => {
    const all = synthAllEnvironments((app, tier) => new TestableStack(app, `m07-testable-${tier.name}`, { tier: tier.name, project: 'demo', assetHash: 'PINNED' }));
    expect(Object.keys(all)).toEqual(['dev', 'staging', 'prod']);
    for (const env of Object.values(all)) {
      expect(get(env.json, 'resource.google_pubsub_topic.Orders.labels.environment')).toBe(env.tier.name);
      expect(get(env.json, 'terraform.backend.local.path')).toMatch(new RegExp(`terraform\\.m07-testable-${env.tier.name}\\.tfstate$`)); // prepareStack added it
    }
    expect(compareTiers(all.dev, all.prod, 'resource.google_pubsub_topic.Orders.message_retention_duration')).toEqual({ same: false, dev: '86400s', prod: '604800s' });
    expect(compareTiers(all.staging, all.prod, 'resource.google_pubsub_topic.Orders.message_retention_duration').same).toBe(true);
    expect(get(all.dev.json, 'resource.nope.x')).toBeUndefined();
  });
});

describe('07 · anti-patterns, demonstrated', () => {
  test('a stack with an unresolved token in a construct id fails at construction, not at synth', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'tok');
    const v = new TerraformVariable(stack, 'Name', { type: 'string' });
    expect(() => new PubsubTopic(stack, `topic-${v.stringValue}`, { name: 'x' })).toThrow(/token/i);
  });

  test('token-typed values cannot be asserted as strings; assert the interpolation instead', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'tok2');
    const sa = new ServiceAccount(stack, 'Sa', { accountId: 'sa' });
    new TerraformOutput(stack, 'Email', { value: sa.email });
    expect(sa.email).toMatch(/^\$\{TfToken\[TOKEN\.\d+\]\}$/); // meaningless before synth
    expect(JSON.parse(Testing.synth(stack)).output.Email.value).toBe('${google_service_account.Sa.email}');
  });
});
