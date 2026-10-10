import * as fs from 'fs';
import * as path from 'path';
import { TerraformOutput, TerraformStack, Testing } from 'cdktf';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { StorageBucketIamMember } from '@cdktf/provider-google/lib/storage-bucket-iam-member';
import { KmsCryptoKey } from '@cdktf/provider-google/lib/kms-crypto-key';
import { KmsCryptoKeyIamMember } from '@cdktf/provider-google/lib/kms-crypto-key-iam-member';
import { PubsubSubscription } from '@cdktf/provider-google/lib/pubsub-subscription';
import { PubsubTopicIamMember } from '@cdktf/provider-google/lib/pubsub-topic-iam-member';
import { PubsubSubscriptionIamMember } from '@cdktf/provider-google/lib/pubsub-subscription-iam-member';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { ServiceAccountIamMember } from '@cdktf/provider-google/lib/service-account-iam-member';
import { DataGoogleStorageBucket } from '@cdktf/provider-google/lib/data-google-storage-bucket';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import {
  ConstructsStack,
  PubSubPipeline,
  RegistryNetwork,
  SecureBucket,
  ServiceAccountWithRoles,
  addToApp,
} from '../src/modules/05-constructs-and-modules';
import { importSecureBucket } from '../src/modules/05-constructs-and-modules/solutions/01-imported-bucket';
import { EncryptionKey } from '../src/modules/05-constructs-and-modules/solutions/02-encryption-key';
import { RegistryVpcWithNat } from '../src/modules/05-constructs-and-modules/solutions/03-module-composition';

Testing.setupJest();

describe('05 · SecureBucket in isolation (Testing.synthScope)', () => {
  it('renders the hardened defaults from a scope callback, no stack boilerplate', () => {
    const synth = Testing.synthScope((scope) => {
      new SecureBucket(scope, 'Data', { tier: ENVIRONMENTS.dev, name: 'cdkm-lib-dev-data', location: 'US', service: 'lib' });
    });
    expect(synth).toHaveResourceWithProperties(StorageBucket, {
      name: 'cdkm-lib-dev-data',
      uniform_bucket_level_access: true,
      public_access_prevention: 'enforced',
      versioning: { enabled: true },
      force_destroy: true,
      lifecycle_rule: [
        { action: { type: 'Delete' }, condition: { days_since_noncurrent_time: 7, with_state: 'ARCHIVED' } },
        { action: { type: 'Delete' }, condition: { num_newer_versions: 5, with_state: 'ARCHIVED' } },
        { action: { type: 'AbortIncompleteMultipartUpload' }, condition: { age: 7 } },
      ],
      labels: expect.objectContaining({ service: 'lib', environment: 'dev' }),
    });
    // Nested construct → hashed logical id; the construct id is the human prefix.
    expect(Object.keys(JSON.parse(synth).resource.google_storage_bucket)[0]).toMatch(/^Data_Bucket_[0-9A-F]{8}$/);
  });

  it('grant* helpers create additive members inside the construct scope', () => {
    const synth = Testing.synthScope((scope) => {
      const b = new SecureBucket(scope, 'Data', { tier: ENVIRONMENTS.dev, name: 'cdkm-lib-dev-data', location: 'US', service: 'lib' });
      b.grantRead('Reader', 'group:analysts@example.com');
      b.grantWrite('Writer', 'serviceAccount:etl@proj.iam.gserviceaccount.com');
    });
    expect(synth).toHaveResourceWithProperties(StorageBucketIamMember, { role: 'roles/storage.objectViewer', member: 'group:analysts@example.com' });
    expect(synth).toHaveResourceWithProperties(StorageBucketIamMember, { role: 'roles/storage.objectUser', member: 'serviceAccount:etl@proj.iam.gserviceaccount.com' });
    expect(Object.keys(JSON.parse(synth).resource.google_storage_bucket_iam_member)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Data_Reader_/), expect.stringMatching(/^Data_Writer_/)]),
    );
  });

  it('CMEK: sets default_kms_key_name and grants the GCS service agent use of the key first', () => {
    const synth = Testing.synthScope((scope) => {
      const key = new KmsCryptoKey(scope, 'Key', { name: 'k', keyRing: 'projects/p/locations/us/keyRings/r' });
      new SecureBucket(scope, 'Data', { tier: ENVIRONMENTS.prod, name: 'cdkm-lib-prod-data', location: 'US', service: 'lib', encryptionKey: key, project: 'p' });
    });
    expect(synth).toHaveResourceWithProperties(StorageBucket, {
      encryption: { default_kms_key_name: '${google_kms_crypto_key.Key.id}' },
      depends_on: [expect.stringMatching(/^google_kms_crypto_key_iam_member\.Data_StorageAgentUsesKey_/)],
    });
    expect(synth).toHaveResourceWithProperties(KmsCryptoKeyIamMember, {
      role: 'roles/cloudkms.cryptoKeyEncrypterDecrypter',
      member: expect.stringMatching(/^serviceAccount:\$\{data\.google_storage_project_service_account\.Data_StorageAgent_/),
    });
  });

  it('node.addValidation errors surface with Testing.synth(stack, true) and list every problem', () => {
    const stack = new TerraformStack(Testing.app(), 'v');
    new SecureBucket(stack, 'Bad', { tier: ENVIRONMENTS.dev, name: 'Bad_Name!', location: 'US', service: 'lib', noncurrentVersionRetentionDays: 0 });
    expect(() => Testing.synth(stack, true)).toThrow(/bucket name "Bad_Name!"[\s\S]*noncurrentVersionRetentionDays must be a positive integer/);
    // Without runValidations, the same stack synthesizes — validations are opt-in for the helper.
    expect(() => Testing.synth(stack)).not.toThrow();
  });

  it('Annotations: an error aborts fullSynth; a warning lands in the manifest', () => {
    // fullSynth runs stack validations, one of which is "every resource has a provider construct".
    const app = Testing.app();
    const stack = new TerraformStack(app, 'a');
    new GoogleProvider(stack, 'Google', {});
    new SecureBucket(stack, 'Unsafe', { tier: ENVIRONMENTS.prod, name: 'cdkm-lib-prod-x', location: 'US', service: 'lib', forceDestroy: true });
    expect(() => Testing.fullSynth(stack)).toThrow(/forceDestroy is not allowed in prod/);

    const app2 = Testing.app();
    const stack2 = new TerraformStack(app2, 'w');
    new GoogleProvider(stack2, 'Google', {});
    new SecureBucket(stack2, 'NoLogs', { tier: ENVIRONMENTS.prod, name: 'cdkm-lib-prod-y', location: 'US', service: 'lib' });
    const outdir = Testing.fullSynth(stack2);
    const manifest = JSON.parse(fs.readFileSync(path.join(outdir, 'manifest.json'), 'utf8'));
    expect(manifest.stacks.w.annotations).toEqual([
      expect.objectContaining({ level: '@cdktf/warn', constructPath: 'w/NoLogs', message: expect.stringContaining('access logs') }),
    ]);
    fs.rmSync(outdir, { recursive: true, force: true });
  });
});

describe('05 · PubSubPipeline and ServiceAccountWithRoles', () => {
  it('pipeline wires DLQ + agent grants; grantPublish/grantSubscribe are additive members in its scope', () => {
    const synth = Testing.synthScope((scope) => {
      const p = new PubSubPipeline(scope, 'Orders', { tier: ENVIRONMENTS.dev, name: 'orders', projectNumber: '123', maxDeliveryAttempts: 10 });
      p.grantPublish('serviceAccount:api@p.iam.gserviceaccount.com');
      p.grantSubscribe('serviceAccount:worker@p.iam.gserviceaccount.com', 'Worker');
    });
    expect(synth).toHaveResourceWithProperties(PubsubSubscription, {
      name: 'orders-sub',
      dead_letter_policy: expect.objectContaining({ max_delivery_attempts: 10 }),
      expiration_policy: { ttl: '' },
    });
    expect(synth).toHaveResourceWithProperties(PubsubTopicIamMember, { member: 'serviceAccount:service-123@gcp-sa-pubsub.iam.gserviceaccount.com', role: 'roles/pubsub.publisher' });
    expect(synth).toHaveResourceWithProperties(PubsubTopicIamMember, { member: 'serviceAccount:api@p.iam.gserviceaccount.com' });
    expect(synth).toHaveResourceWithProperties(PubsubSubscriptionIamMember, { member: 'serviceAccount:worker@p.iam.gserviceaccount.com' });
    expect(Object.keys(JSON.parse(synth).resource.google_pubsub_subscription_iam_member)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Orders_Worker_/)]),
    );
  });

  it('pipeline rejects out-of-range delivery attempts at validation time', () => {
    const stack = new TerraformStack(Testing.app(), 'v');
    new PubSubPipeline(stack, 'Bad', { tier: ENVIRONMENTS.dev, name: 'x', projectNumber: '1', maxDeliveryAttempts: 3, ackDeadlineSeconds: 5 });
    expect(() => Testing.synth(stack, true)).toThrow(/maxDeliveryAttempts must be an integer in \[5, 100\][\s\S]*ackDeadlineSeconds/);
  });

  it('service account: one ProjectIamMember per role with a role-derived id; primitive roles are an error annotation', () => {
    const synth = Testing.synthScope((scope) => {
      const sa = new ServiceAccountWithRoles(scope, 'Worker', { accountId: 'cdkm-lib-dev-worker', project: 'p', roles: ['roles/logging.logWriter', 'roles/pubsub.subscriber'] });
      sa.grantImpersonation('group:devs@example.com');
      sa.grantActAs('serviceAccount:deployer@p.iam.gserviceaccount.com');
    });
    const json = JSON.parse(synth);
    expect(Object.keys(json.resource.google_project_iam_member).sort()).toEqual([
      expect.stringMatching(/^Worker_RoleloggerlogWriter_|^Worker_RolelogginglogWriter_/),
      expect.stringMatching(/^Worker_Rolepubsubsubscriber_/),
    ]);
    expect(synth).toHaveResourceWithProperties(ProjectIamMember, {
      role: 'roles/pubsub.subscriber',
      member: expect.stringMatching(/^\$\{google_service_account\.Worker_Account_[0-9A-F]{8}\.member\}$/),
    });
    expect(synth).toHaveResourceWithProperties(ServiceAccountIamMember, { role: 'roles/iam.serviceAccountTokenCreator', member: 'group:devs@example.com' });
    expect(synth).toHaveResourceWithProperties(ServiceAccountIamMember, { role: 'roles/iam.serviceAccountUser' });

    const stack = new TerraformStack(Testing.app(), 'e');
    new GoogleProvider(stack, 'Google', {});
    new ServiceAccountWithRoles(stack, 'Owner', { accountId: 'cdkm-lib-dev-owner', project: 'p', roles: ['roles/owner'] });
    expect(() => Testing.fullSynth(stack)).toThrow(/primitive role roles\/owner is not allowed/);

    const stack2 = new TerraformStack(Testing.app(), 'e2');
    new ServiceAccountWithRoles(stack2, 'Bad', { accountId: 'x', project: 'p', roles: ['editor'] });
    expect(() => Testing.synth(stack2, true)).toThrow(/accountId "x"[\s\S]*role "editor" is not a valid/);
  });
});

describe('05 · Terraform Registry module via TerraformHclModule', () => {
  it('emits a module block with source, version and translated variables; outputs are module references', () => {
    const stack = new TerraformStack(Testing.app(), 'm');
    const net = new RegistryNetwork(stack, 'Net', {
      project: 'p',
      networkName: 'vpc',
      subnets: [{ name: 'workloads', cidr: '10.0.0.0/24', region: 'us-central1', secondaryRanges: { pods: '10.4.0.0/14' } }],
    });
    new TerraformOutput(stack, 'name', { value: net.networkName });
    new TerraformOutput(stack, 'ids', { value: net.subnetIds });
    const json = JSON.parse(Testing.synth(stack));
    expect(json.module.Net_Vpc_BB1FDE83 ?? Object.values(json.module)[0]).toEqual({
      source: 'terraform-google-modules/network/google',
      version: '~> 11.0',
      project_id: 'p',
      network_name: 'vpc',
      routing_mode: 'REGIONAL',
      subnets: [{ subnet_name: 'workloads', subnet_ip: '10.0.0.0/24', subnet_region: 'us-central1', subnet_private_access: 'true' }],
      secondary_ranges: { workloads: [{ range_name: 'pods', ip_cidr_range: '10.4.0.0/14' }] },
    });
    const moduleId = Object.keys(json.module)[0];
    expect(json.output.name.value).toBe(`\${module.${moduleId}.network_name}`);
    expect(json.output.ids.value).toBe(`\${module.${moduleId}.subnets_ids}`);
    // Nothing was downloaded: synth is offline. terraform init fetches the module.
    expect(json.terraform?.required_providers).toBeUndefined();
  });
});

describe('05 · ConstructsStack', () => {
  it('composes the constructs; CMEK is opt-in', () => {
    const plain = new ConstructsStack(Testing.app(), 'm05-constructs', { tier: 'dev', project: 'p' });
    const synth = Testing.synth(plain);
    const json = JSON.parse(synth);
    expect(json.resource.google_kms_crypto_key).toBeUndefined();
    expect(Object.keys(json.resource.google_storage_bucket)).toHaveLength(2);
    expect(synth).toHaveResourceWithProperties(StorageBucket, {
      name: 'cdkm-lib-dev-data',
      logging: { log_bucket: expect.stringMatching(/^\$\{google_storage_bucket\.Logs_Bucket_/), log_object_prefix: 'cdkm-lib-dev-data' },
    });
    expect(synth).toHaveResourceWithProperties(PubsubSubscriptionIamMember, { member: expect.stringMatching(/Worker_Account.*\.member/) });

    const cmek = new ConstructsStack(Testing.app(), 'm05-constructs', { tier: 'dev', project: 'p', cmek: true });
    expect(Testing.synth(cmek)).toHaveResourceWithProperties(KmsCryptoKey, { rotation_period: '7776000s' });
    expect(Testing.synth(cmek)).toHaveResourceWithProperties(StorageBucket, {
      name: 'cdkm-lib-dev-data',
      encryption: { default_kms_key_name: '${google_kms_crypto_key.BucketKey.id}' },
    });
  });

  it('addToApp registers m05-constructs and fullSynth passes validations', () => {
    const app = Testing.app();
    addToApp(app);
    expect(app.node.children.map((c) => c.node.id)).toEqual(['m05-constructs']);
    const outdir = Testing.fullSynth(app.node.children[0] as ConstructsStack);
    expect(fs.existsSync(path.join(outdir, 'stacks', 'm05-constructs', 'cdk.tf.json'))).toBe(true);
    fs.rmSync(outdir, { recursive: true, force: true });
  });
});

describe('05 · exercise solutions', () => {
  it('1: importSecureBucket returns an ISecureBucket backed by a data source; grant* works the same', () => {
    const synth = Testing.synthScope((scope) => {
      const b = importSecureBucket(scope, 'Shared', 'some-team-bucket');
      b.grantRead('Reader', 'group:us@example.com');
      new TerraformOutput(scope, 'url', { value: b.bucketUrl });
    });
    expect(synth).toHaveDataSourceWithProperties(DataGoogleStorageBucket, { name: 'some-team-bucket' });
    expect(synth).toHaveResourceWithProperties(StorageBucketIamMember, {
      bucket: expect.stringMatching(/^\$\{data\.google_storage_bucket\.Shared_Bucket_[0-9A-F]{8}\.name\}$/),
      role: 'roles/storage.objectViewer',
    });
    expect(JSON.parse(synth).output.url.value).toMatch(/^\$\{data\.google_storage_bucket\.Shared_Bucket_[0-9A-F]{8}\.url\}$/);
  });

  it('2: EncryptionKey validates rotation, warns beyond policy, and grants use to service agents', () => {
    const synth = Testing.synthScope((scope) => {
      const key = new EncryptionKey(scope, 'Key', { tier: ENVIRONMENTS.prod, keyRingName: 'ring', keyName: 'data', location: 'us-central1', rotationDays: 30 });
      key.grantEncryptDecrypt('serviceAccount:service-1@gs-project-accounts.iam.gserviceaccount.com');
      new SecureBucket(scope, 'Data', { tier: ENVIRONMENTS.prod, name: 'cdkm-lib-prod-data', location: 'us-central1', service: 'lib', encryptionKey: key.key, project: 'p' });
    });
    expect(synth).toHaveResourceWithProperties(KmsCryptoKey, {
      rotation_period: '2592000s',
      version_template: { algorithm: 'GOOGLE_SYMMETRIC_ENCRYPTION', protection_level: 'HSM' },
      lifecycle: { prevent_destroy: true },
    });
    expect(synth).toHaveResourceWithProperties(KmsCryptoKeyIamMember, { member: 'serviceAccount:service-1@gs-project-accounts.iam.gserviceaccount.com' });

    const stack = new TerraformStack(Testing.app(), 'k');
    new EncryptionKey(stack, 'Bad', { tier: ENVIRONMENTS.dev, keyRingName: 'r', keyName: 'k', location: 'us', rotationDays: 0 });
    expect(() => Testing.synth(stack, true)).toThrow(/rotationDays must be an integer in \[1, 365\]/);

    const warn = new TerraformStack(Testing.app(), 'w');
    new GoogleProvider(warn, 'Google', {});
    new EncryptionKey(warn, 'Slow', { tier: ENVIRONMENTS.prod, keyRingName: 'r', keyName: 'k', location: 'us', rotationDays: 180 });
    const outdir = Testing.fullSynth(warn);
    const manifest = JSON.parse(fs.readFileSync(path.join(outdir, 'manifest.json'), 'utf8'));
    expect(manifest.stacks.w.annotations[0]).toMatchObject({ level: '@cdktf/warn', message: expect.stringContaining('90-day policy') });
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  it('3: two Registry modules composed; NAT consumes the VPC output and depends on the VPC module', () => {
    const stack = new TerraformStack(Testing.app(), 'm');
    const vpc = new RegistryVpcWithNat(stack, 'Vpc', {
      project: 'p',
      region: 'us-central1',
      networkName: 'vpc',
      subnets: [{ name: 'a', cidr: '10.0.0.0/24', region: 'us-central1' }],
    });
    new TerraformOutput(stack, 'nat', { value: vpc.natName });
    const json = JSON.parse(Testing.synth(stack));
    const ids = Object.keys(json.module);
    // Path Vpc/Vpc/Vpc collapses to Vpc_<hash>: makeUniqueId removes consecutive duplicate components.
    const natId = ids.find((i) => i.includes('Nat'))!;
    const vpcId = ids.find((i) => i !== natId)!;
    expect(vpcId).toMatch(/^Vpc_[0-9A-F]{8}$/);
    expect(json.module[natId]).toMatchObject({
      source: 'terraform-google-modules/cloud-nat/google',
      version: '~> 5.0',
      network: `\${module.${vpcId}.network_name}`,
      router: 'vpc-router',
      depends_on: [`module.${vpcId}`],
    });
    expect(json.output.nat.value).toBe(`\${module.${natId}.name}`);
  });
});
