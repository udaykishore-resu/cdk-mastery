import { Annotations, Aspects, TerraformStack, Testing } from 'cdktf';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { StorageBucketIamBinding } from '@cdktf/provider-google/lib/storage-bucket-iam-binding';
import { StorageBucketIamMember } from '@cdktf/provider-google/lib/storage-bucket-iam-member';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { SqlDatabaseInstance } from '@cdktf/provider-google/lib/sql-database-instance';
import { KmsKeyRing } from '@cdktf/provider-google/lib/kms-key-ring';
import { KmsCryptoKey } from '@cdktf/provider-google/lib/kms-crypto-key';
import { OrgPolicyPolicy } from '@cdktf/provider-google/lib/org-policy-policy';
import { PascalCaseIds } from '@cdk-mastery/shared';
import {
  ConstructPolicyAspect,
  GovernedStack,
  LabelsAspect,
  NoPublicBucketsAspect,
  OrgPoliciesStack,
  RequireCmekAspect,
  StatefulProtectionAspect,
  isLabelledResource,
  normaliseLabels,
} from '../src/modules/06-aspects-labels-and-governance';
import { RequireLabelKeysAspect } from '../src/modules/06-aspects-labels-and-governance/solutions/require-label-keys-aspect';
import { RegionAllowlistAspect } from '../src/modules/06-aspects-labels-and-governance/solutions/region-allowlist-aspect';
import { CmekLocationAspect, compatibleKeyLocations, resolveReference } from '../src/modules/06-aspects-labels-and-governance/solutions/cmek-location-aspect';
import { environmentFor } from '@cdk-mastery/shared';

// test/setup.ts imports the adapter for its *types* only; the matchers are
// registered by this call (idempotent, so every test file does it for itself).
Testing.setupJest();

/** Collect `@cdktf/error` annotations from a stack tree without synthesising. */
function errorsIn(stack: TerraformStack): string[] {
  return stack.node
    .findAll()
    .flatMap((n) => n.node.metadata.filter((m) => m.type === '@cdktf/error').map((m) => `[${n.node.path}] ${m.data}`));
}

describe('06 · LabelsAspect (mutating)', () => {
  test('labels every resource that accepts labels, normalising keys and values, and skips the rest', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'labels');
    new GoogleProvider(stack, 'Google', { project: 'p' });
    const bucket = new StorageBucket(stack, 'Bucket', { name: 'b', location: 'US', labels: { Team: 'Platform Eng' } });
    const sa = new ServiceAccount(stack, 'Sa', { accountId: 'sa' }); // no labels argument
    const aspect = new LabelsAspect({ labels: { Environment: 'Prod', 'Cost-Center': 'CC 42' } });
    Aspects.of(stack).add(aspect);

    const synth = Testing.synth(stack);
    expect(synth).toHaveResourceWithProperties(StorageBucket, {
      labels: { team: 'platform_eng', environment: 'prod', 'cost-center': 'cc_42' },
    });
    expect(isLabelledResource(bucket)).toBe(true);
    expect(isLabelledResource(sa)).toBe(false);
    expect(aspect.applied).toEqual(['labels/Bucket']);
    expect(JSON.parse(synth).resource.google_service_account.Sa.labels).toBeUndefined();
  });

  test('existing labels win by default; existingWins:false makes the aspect authoritative', () => {
    const build = (existingWins: boolean) =>
      Testing.synthScope((scope) => {
        new StorageBucket(scope, 'Bucket', { name: 'b', location: 'US', labels: { environment: 'sandbox' } });
        Aspects.of(scope).add(new LabelsAspect({ labels: { environment: 'prod' }, existingWins }));
      });
    expect(build(true)).toHaveResourceWithProperties(StorageBucket, { labels: { environment: 'sandbox' } });
    expect(build(false)).toHaveResourceWithProperties(StorageBucket, { labels: { environment: 'prod' } });
  });

  test('token values are passed through untouched (normalising a token would corrupt it)', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 's');
    const sa = new ServiceAccount(stack, 'Sa', { accountId: 'sa' });
    const email = sa.email; // every attribute read mints a new token; hold one
    const out = normaliseLabels({ 'Owner Email': email, Plain: 'Mixed Case' });
    expect(out.owner_email).toBe(email);
    expect(out.plain).toBe('mixed_case');
  });
});

describe('06 · validating aspects and how errors surface', () => {
  function badStack() {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'bad');
    new GoogleProvider(stack, 'Google', { project: 'p' });
    const bucket = new StorageBucket(stack, 'Public', { name: 'pub', location: 'US' });
    new StorageBucketIamMember(stack, 'AllUsers', { bucket: bucket.name, role: 'roles/storage.objectViewer', member: 'allUsers' });
    new StorageBucketIamBinding(stack, 'Binding', { bucket: bucket.name, role: 'roles/storage.objectViewer', members: ['user:a@example.com', 'allAuthenticatedUsers'] });
    new SqlDatabaseInstance(stack, 'Db', { databaseVersion: 'POSTGRES_16', settings: { tier: 'db-f1-micro' } });
    Aspects.of(stack).add(new NoPublicBucketsAspect());
    Aspects.of(stack).add(new RequireCmekAspect());
    return stack;
  }

  test('Testing.synth() does NOT throw on Annotations errors; it only records them on the nodes', () => {
    const stack = badStack();
    expect(() => Testing.synth(stack)).not.toThrow();
    const errors = errorsIn(stack);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('[bad/AllUsers] bucket IAM member "allUsers"'),
        expect.stringContaining('[bad/Binding] bucket IAM binding grants roles/storage.objectViewer to allAuthenticatedUsers'),
        expect.stringContaining("[bad/Public] bucket \"pub\" must set publicAccessPrevention: 'enforced'"),
        expect.stringContaining('[bad/Public] bucket "pub" must use a customer-managed key'),
        expect.stringContaining('[bad/Db] Cloud SQL instance'),
      ]),
    );
    expect(errors).toHaveLength(5);
  });

  test('Testing.fullSynth() (the real synthesizer, same as app.synth / cdktf synth) throws and lists every error', () => {
    const stack = badStack();
    expect(() => Testing.fullSynth(stack)).toThrow(/Encountered Annotations with level "ERROR"/);
    expect(() => Testing.fullSynth(stack)).toThrow(/\[bad\/Public\].*customer-managed key/);
    expect(() => Testing.fullSynth(stack)).toThrow(/\[bad\/AllUsers\]/);
  });

  test('a compliant tree passes both aspects with zero annotations', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'good');
    new GoogleProvider(stack, 'Google', { project: 'p' });
    const bucket = new StorageBucket(stack, 'B', {
      name: 'b', location: 'US', publicAccessPrevention: 'enforced', encryption: { defaultKmsKeyName: 'projects/p/locations/us/keyRings/r/cryptoKeys/k' },
    });
    new StorageBucketIamMember(stack, 'M', { bucket: bucket.name, role: 'roles/storage.objectViewer', member: 'group:readers@example.com' });
    Aspects.of(stack).add(new NoPublicBucketsAspect());
    Aspects.of(stack).add(new RequireCmekAspect({ allowedKeys: ['projects/p/locations/us/keyRings/r/cryptoKeys/k'] }));
    expect(() => Testing.fullSynth(stack)).not.toThrow();
    expect(errorsIn(stack)).toEqual([]);
  });

  test('RequireCmekAspect with an allow-list rejects unknown keys', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'keys');
    new StorageBucket(stack, 'B', { name: 'b', location: 'US', encryption: { defaultKmsKeyName: 'projects/p/locations/us/keyRings/r/cryptoKeys/other' } });
    Aspects.of(stack).add(new RequireCmekAspect({ allowedKeys: ['projects/p/locations/us/keyRings/r/cryptoKeys/k'] }));
    Testing.synth(stack);
    expect(errorsIn(stack)[0]).toMatch(/not in the approved key list/);
  });
});

describe('06 · ConstructPolicy bridge', () => {
  test('shared PascalCaseIds violations become Annotations errors on the offending node', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'policy');
    new GoogleProvider(stack, 'Google', { project: 'p' });
    new StorageBucket(stack, 'my_bucket', { name: 'b', location: 'US' });
    new StorageBucket(stack, 'GoodBucket', { name: 'b2', location: 'US' });
    const bridge = new ConstructPolicyAspect([PascalCaseIds]);
    Aspects.of(stack).add(bridge);
    Testing.synth(stack);
    expect(bridge.policy.violations).toHaveLength(1);
    expect(bridge.policy.violations[0]).toMatchObject({ path: 'policy/my_bucket', rule: 'naming/pascal-case-ids' });
    expect(errorsIn(stack)).toEqual(['[policy/my_bucket] [naming/pascal-case-ids] construct id "my_bucket" is not PascalCase']);
    expect(() => Testing.fullSynth(stack)).toThrow(/naming\/pascal-case-ids/);
  });
});

describe('06 · StatefulProtectionAspect (typed mutation + addOverride)', () => {
  const build = (tier: string) => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'protect');
    new GoogleProvider(stack, 'Google', { project: 'p' });
    new StorageBucket(stack, 'B', { name: 'b', location: 'US', lifecycle: { ignoreChanges: ['labels'] } });
    new SqlDatabaseInstance(stack, 'Db', { databaseVersion: 'POSTGRES_16', settings: { tier: 'db-f1-micro' } });
    Aspects.of(stack).add(new StatefulProtectionAspect(environmentFor(tier)));
    return JSON.parse(Testing.synth(stack));
  };

  test('prod: prevent_destroy, force_destroy=false, deletion protection on both sides, existing lifecycle preserved', () => {
    const json = build('prod');
    const bucket = json.resource.google_storage_bucket.B;
    expect(bucket.lifecycle).toEqual({ ignore_changes: ['labels'], prevent_destroy: true });
    expect(bucket.force_destroy).toBe(false);
    const db = json.resource.google_sql_database_instance.Db;
    expect(db.deletion_protection).toBe(true);
    // addOverride merged into the *rendered* settings object (not settings.0)
    expect(db.settings).toEqual({ tier: 'db-f1-micro', deletion_protection_enabled: true });
  });

  test('dev: the same aspect relaxes everything', () => {
    const json = build('dev');
    expect(json.resource.google_storage_bucket.B.lifecycle).toEqual({ ignore_changes: ['labels'], prevent_destroy: false });
    expect(json.resource.google_storage_bucket.B.force_destroy).toBe(true);
    expect(json.resource.google_sql_database_instance.Db.settings.deletion_protection_enabled).toBe(false);
  });

  test('addOverride on a list key APPENDS to the rendered list (deepMerge semantics)', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'merge');
    const b = new StorageBucket(stack, 'B', { name: 'b', location: 'US', lifecycle: { ignoreChanges: ['labels'] } });
    b.addOverride('lifecycle.ignore_changes', ['cors']);
    const json = JSON.parse(Testing.synth(stack));
    expect(json.resource.google_storage_bucket.B.lifecycle.ignore_changes).toEqual(['labels', 'cors']);
  });
});

describe('06 · GovernedStack', () => {
  test('prod stack is compliant: synthesizes fully, labelled, CMEK, conditions rendered, overrideLogicalId applied', () => {
    const app = Testing.app();
    const stack = new GovernedStack(app, 'm06-governed', { tier: 'prod', project: 'demo', region: 'us-central1' });
    const synth = Testing.synth(stack);
    const json = JSON.parse(synth);

    expect(synth).toHaveResourceWithProperties(StorageBucket, {
      public_access_prevention: 'enforced',
      uniform_bucket_level_access: true,
      labels: { environment: 'prod', service: 'governance', owner: 'platform-oncall', 'cost-center': 'cc-platform-prod', 'managed-by': 'cdk-mastery', team: 'platform_eng' },
    });
    const bucket = json.resource.google_storage_bucket.AuditBucket;
    expect(bucket.encryption.default_kms_key_name).toBe('${google_kms_crypto_key.BucketKey.id}');
    expect(bucket.lifecycle.prevent_destroy).toBe(true);
    expect(bucket.lifecycle.precondition[0].condition).toBe('${(upper(google_kms_key_ring.Ring.location) == "US-CENTRAL1")}');
    expect(bucket.lifecycle.postcondition.map((p: { condition: string }) => p.condition)).toEqual([
      '${(self.public_access_prevention == "enforced")}',
      '${self.uniform_bucket_level_access}',
    ]);
    // variable renamed via overrideLogicalId; references follow the new name
    expect(json.variable.retention_days).toMatchObject({ type: 'number', default: 365 });
    expect(json.variable.RetentionDays).toBeUndefined();
    expect(bucket.retention_policy.retention_period).toBe('${(var.retention_days * 86400)}');
    expect(json.variable.retention_days.validation[0].condition).toBe('${(var.retention_days >= 1)}');
    // every labelled resource got the mandatory labels
    for (const [type, instances] of Object.entries<Record<string, { labels?: Record<string, string> }>>(json.resource)) {
      for (const [id, cfg] of Object.entries(instances)) {
        if (cfg.labels) expect({ type, id, env: cfg.labels.environment }).toEqual({ type, id, env: 'prod' });
      }
    }
    expect(() => Testing.fullSynth(stack)).not.toThrow();
  });

  test('dev stack relaxes protection but keeps the security rules', () => {
    const app = Testing.app();
    const stack = new GovernedStack(app, 'm06-governed-dev', { tier: 'dev', project: 'demo' });
    const json = JSON.parse(Testing.synth(stack));
    expect(json.resource.google_storage_bucket.AuditBucket.force_destroy).toBe(true);
    expect(json.resource.google_storage_bucket.AuditBucket.public_access_prevention).toBe('enforced');
    expect(json.resource.google_sql_database_instance.AuditDb.deletion_protection).toBe(false);
  });

  test('introduceViolations: the validating aspects abort synthesis with every violation listed', () => {
    const app = Testing.app();
    const stack = new GovernedStack(app, 'm06-bad', { tier: 'prod', project: 'demo', introduceViolations: true });
    expect(() => Testing.fullSynth(stack)).toThrow(/allUsers/);
    const errors = errorsIn(stack);
    expect(errors.some((e) => e.includes('publicAccessPrevention'))).toBe(true);
    expect(errors.some((e) => e.includes('customer-managed key') && e.includes('bucket'))).toBe(true);
    expect(errors.some((e) => e.includes('Cloud SQL instance'))).toBe(true);
  });
});

describe('06 · OrgPoliciesStack', () => {
  test('renders boolean and list constraints under the given parent', () => {
    const app = Testing.app();
    const stack = new OrgPoliciesStack(app, 'm06-org-policies', { parent: 'folders/123', project: 'demo' });
    const synth = Testing.synth(stack);
    expect(synth).toHaveResourceWithProperties(OrgPolicyPolicy, {
      name: 'folders/123/policies/storage.publicAccessPrevention',
      parent: 'folders/123',
      spec: { rules: [{ enforce: 'TRUE' }] },
    });
    expect(synth).toHaveResourceWithProperties(OrgPolicyPolicy, {
      name: 'folders/123/policies/compute.vmExternalIpAccess',
      spec: { rules: [{ deny_all: 'TRUE' }] },
    });
    expect(synth).toHaveResourceWithProperties(OrgPolicyPolicy, { name: 'folders/123/policies/iam.disableServiceAccountKeyCreation' });
    expect(Object.keys(JSON.parse(synth).resource.google_org_policy_policy)).toHaveLength(4);
    expect(() => Testing.fullSynth(stack)).not.toThrow();
  });

  test('defaults the parent to the project', () => {
    const app = Testing.app();
    const stack = new OrgPoliciesStack(app, 'm06-org-policies', { project: 'demo' });
    expect(Testing.synth(stack)).toHaveResourceWithProperties(OrgPolicyPolicy, { parent: 'projects/demo' });
  });
});

describe('06 · exercise solutions', () => {
  test('1. RequireLabelKeysAspect flags missing keys only on labelled resources', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'ex1');
    new StorageBucket(stack, 'B', { name: 'b', location: 'US', labels: { environment: 'dev' } });
    new ServiceAccount(stack, 'Sa', { accountId: 'sa' });
    Aspects.of(stack).add(new RequireLabelKeysAspect(['environment', 'owner']));
    Testing.synth(stack);
    expect(errorsIn(stack)).toEqual(['[ex1/B] google_storage_bucket is missing required labels: owner']);
  });

  test('1b. LabelsAspect followed by RequireLabelKeysAspect proves the mutation for every type', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'ex1b');
    new StorageBucket(stack, 'B', { name: 'b', location: 'US' });
    new SqlDatabaseInstance(stack, 'Db', { databaseVersion: 'POSTGRES_16', settings: { tier: 'db-f1-micro' } }); // has user_labels, not labels
    Aspects.of(stack).add(new LabelsAspect({ labels: { environment: 'dev', owner: 'me' } }));
    Aspects.of(stack).add(new RequireLabelKeysAspect(['environment', 'owner']));
    Testing.synth(stack);
    expect(errorsIn(stack)).toEqual([]);
  });

  test('2. RegionAllowlistAspect: regions, zones, multi-regions, tokens and severity', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'ex2');
    new StorageBucket(stack, 'Ok', { name: 'a', location: 'US-CENTRAL1' });
    new StorageBucket(stack, 'MultiOk', { name: 'b', location: 'US' });
    new StorageBucket(stack, 'Bad', { name: 'c', location: 'EU' });
    new KmsKeyRing(stack, 'Ring', { name: 'r', location: 'europe-west4' });
    new KmsKeyRing(stack, 'GlobalRing', { name: 'g', location: 'global' });
    new SqlDatabaseInstance(stack, 'Db', { databaseVersion: 'POSTGRES_16', region: 'asia-east1', settings: { tier: 'db-f1-micro' } });
    Aspects.of(stack).add(new RegionAllowlistAspect({ allowedRegions: ['us-central1'], allowedMultiRegions: ['US'] }));
    Testing.synth(stack);
    const errors = errorsIn(stack);
    expect(errors).toHaveLength(3);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('[ex2/Bad]'), expect.stringContaining('[ex2/Ring]'), expect.stringContaining('[ex2/Db]')]));

    const warnStack = new TerraformStack(Testing.app(), 'ex2w');
    new StorageBucket(warnStack, 'Bad', { name: 'c', location: 'EU' });
    Aspects.of(warnStack).add(new RegionAllowlistAspect({ allowedRegions: ['us-central1'], severity: 'warn' }));
    Testing.synth(warnStack);
    expect(errorsIn(warnStack)).toEqual([]);
    expect(warnStack.node.findAll().flatMap((n) => n.node.metadata.filter((m) => m.type === '@cdktf/warn'))).toHaveLength(1);
  });

  test('3. compatibleKeyLocations encodes the GCS/KMS location rules', () => {
    expect(compatibleKeyLocations('US-CENTRAL1')).toEqual(['us-central1', 'us']);
    expect(compatibleKeyLocations('EUROPE-WEST4')).toEqual(['europe-west4', 'europe']);
    expect(compatibleKeyLocations('US')).toEqual(['us']);
    expect(compatibleKeyLocations('EU')).toEqual(['europe']);
    expect(compatibleKeyLocations('NAM4')).toEqual(['us']);
    expect(compatibleKeyLocations('EUR4')).toEqual(['europe']);
  });

  test('3. CmekLocationAspect resolves the key token back to the key ring and validates locations', () => {
    const build = (ringLocation: string) => {
      const app = Testing.app();
      const stack = new TerraformStack(app, 'ex3');
      new GoogleProvider(stack, 'Google', { project: 'p' });
      // bucket declared BEFORE the key: proves the two-pass design
      const bucket = new StorageBucket(stack, 'B', { name: 'b', location: 'EU' });
      const ring = new KmsKeyRing(stack, 'Ring', { name: 'r', location: ringLocation });
      const key = new KmsCryptoKey(stack, 'Key', { name: 'k', keyRing: ring.id });
      bucket.putEncryption({ defaultKmsKeyName: key.id }); // nested blocks use put*/reset*, not a setter
      const aspect = new CmekLocationAspect();
      Aspects.of(stack).add(aspect);
      return { stack, aspect, key };
    };

    const bad = build('us');
    // default Testing.synth: aspects run, validations do not -> nothing thrown yet
    expect(() => Testing.synth(bad.stack)).not.toThrow();
    expect(bad.aspect.finalize()).toEqual(['bucket "b" in EU uses a key in us; allowed: europe']);
    // the registered stack validation makes the real synthesizer fail
    expect(() => Testing.fullSynth(bad.stack)).toThrow(/uses a key in us/);

    const good = build('europe');
    expect(() => Testing.synth(good.stack, true)).not.toThrow();
    expect(good.aspect.finalize()).toEqual([]);
    // two reads of the same attribute are different tokens but resolve identically
    expect(good.key.id).not.toBe(good.key.id);
    expect(resolveReference(good.stack, good.key.id)).toBe('${google_kms_crypto_key.Key.id}');
    expect(resolveReference(good.stack, 'literal')).toBe('literal');
  });
});

describe('06 · Annotations API sanity', () => {
  test('addWarning and addInfo never abort synthesis', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'warn');
    new GoogleProvider(stack, 'Google', { project: 'p' });
    const b = new StorageBucket(stack, 'B', { name: 'b', location: 'US' });
    Annotations.of(b).addWarning('consider CMEK');
    Annotations.of(b).addInfo('fyi');
    expect(() => Testing.fullSynth(stack)).not.toThrow();
  });
});
