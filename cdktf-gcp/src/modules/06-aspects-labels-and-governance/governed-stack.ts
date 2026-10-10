import { Aspects, Fn, Op, TerraformOutput, TerraformStack, TerraformVariable, ref } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { KmsCryptoKey } from '@cdktf/provider-google/lib/kms-crypto-key';
import { KmsKeyRing } from '@cdktf/provider-google/lib/kms-key-ring';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { StorageBucketIamMember } from '@cdktf/provider-google/lib/storage-bucket-iam-member';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { SqlDatabaseInstance } from '@cdktf/provider-google/lib/sql-database-instance';
import { EnvironmentTier, PascalCaseIds, environmentFor, mandatoryTags, maxDepthRule, resourceName } from '@cdk-mastery/shared';
import { gcpProject, gcpRegion } from './gcp-config';
import { LabelsAspect } from './labels-aspect';
import { NoPublicBucketsAspect } from './no-public-buckets-aspect';
import { ConstructPolicyAspect } from './policy-bridge';
import { RequireCmekAspect } from './require-cmek-aspect';
import { StatefulProtectionAspect } from './stateful-protection-aspect';

export interface GovernedStackProps {
  readonly tier: string;
  readonly project?: string;
  readonly region?: string;
  /**
   * Set to true to build a deliberately non-compliant stack (public bucket,
   * missing CMEK). The tests use it to prove the validating aspects fire; a real
   * app never sets it.
   */
  readonly introduceViolations?: boolean;
}

/**
 * A stack that is compliant *because of* its aspects, not because every author
 * remembered every rule. The resources themselves are ordinary; the last ten
 * lines of the constructor are the governance.
 */
export class GovernedStack extends TerraformStack {
  readonly tier: EnvironmentTier;
  readonly bucket: StorageBucket;
  readonly key: KmsCryptoKey;

  constructor(scope: Construct, id: string, props: GovernedStackProps) {
    super(scope, id);
    this.tier = environmentFor(props.tier);
    const project = props.project ?? gcpProject();
    const region = props.region ?? gcpRegion();
    new GoogleProvider(this, 'Google', { project, region });

    // -- Inputs and a Terraform-time precondition on a *variable* ------------
    // Aspects can only check what is known at synth time. The retention period
    // may arrive via `TF_VAR_retention_days` at plan time, so the check has to
    // live in Terraform: `validation` on the variable.
    const retentionDays = new TerraformVariable(this, 'RetentionDays', {
      type: 'number',
      default: this.tier.logRetentionDays,
      description: 'Object retention in days for the audit bucket',
      validation: [
        {
          condition: Op.gte(ref('var.retention_days'), 1),
          errorMessage: 'retention_days must be at least 1',
        },
      ],
    });
    // The construct id is PascalCase (house rule, enforced below), but Terraform
    // variable names are conventionally snake_case and become `TF_VAR_<name>`.
    // `overrideLogicalId` decouples the two: the tree keeps `RetentionDays`, the
    // rendered JSON says `variable "retention_days"`.
    retentionDays.overrideLogicalId('retention_days');

    // -- CMEK ---------------------------------------------------------------
    const ring = new KmsKeyRing(this, 'Ring', {
      name: resourceName({ org: 'cdkm', service: 'gov', env: this.tier.name, component: 'ring' }),
      location: region,
    });
    this.key = new KmsCryptoKey(this, 'BucketKey', {
      name: resourceName({ org: 'cdkm', service: 'gov', env: this.tier.name, component: 'bucket-key' }),
      keyRing: ring.id,
      rotationPeriod: '7776000s', // 90 days
      // Key rings and keys cannot be deleted in GCP; without this Terraform would
      // fail to destroy the stack, and with it the key is simply abandoned in state.
      lifecycle: { preventDestroy: this.tier.retainStatefulResources },
    });

    // -- The audit bucket, with resource-level pre/postconditions --------------
    this.bucket = new StorageBucket(this, 'AuditBucket', {
      name: resourceName({ org: 'cdkm', service: 'gov', env: this.tier.name, component: 'audit', region }),
      location: region.toUpperCase(),
      uniformBucketLevelAccess: true,
      publicAccessPrevention: props.introduceViolations ? 'inherited' : 'enforced',
      encryption: props.introduceViolations ? undefined : { defaultKmsKeyName: this.key.id },
      retentionPolicy: { retentionPeriod: Op.mul(retentionDays.numberValue, 86400) },
      labels: { Team: 'Platform Eng' }, // deliberately non-normalised; the aspect fixes it
      lifecycle: {
        // precondition: evaluated before the resource is planned. Can reference
        // variables, data sources and other resources, never `self`.
        // GCS rejects a CMEK whose key ring is in a different location from the
        // bucket, but only at object-write time. Fail the plan instead.
        precondition: [
          {
            condition: Op.eq(Fn.upper(ring.location), region.toUpperCase()),
            errorMessage: `the CMEK key ring must live in ${region} (the bucket's location)`,
          },
        ],
        // postcondition: evaluated after apply against the *real* object via
        // `self`. This is the only place `self` is legal. It turns a silent
        // provider default into a hard failure.
        postcondition: [
          {
            condition: Op.eq(ref('self.public_access_prevention'), 'enforced'),
            errorMessage: 'public access prevention was not enforced after apply',
          },
          {
            condition: ref('self.uniform_bucket_level_access'),
            errorMessage: 'uniform bucket-level access must be on',
          },
        ],
      },
    });

    const reader = new ServiceAccount(this, 'AuditReader', {
      accountId: resourceName({ org: 'cdkm', service: 'gov', env: this.tier.name, component: 'reader' }).slice(0, 30),
      displayName: 'Audit log reader',
    });
    new StorageBucketIamMember(this, 'ReaderBinding', {
      bucket: this.bucket.name,
      role: 'roles/storage.objectViewer',
      member: props.introduceViolations ? 'allUsers' : reader.member,
    });

    new SqlDatabaseInstance(this, 'AuditDb', {
      name: resourceName({ org: 'cdkm', service: 'gov', env: this.tier.name, component: 'db' }),
      databaseVersion: 'POSTGRES_16',
      region,
      encryptionKeyName: props.introduceViolations ? undefined : this.key.id,
      settings: { tier: this.tier.highlyAvailable ? 'db-custom-2-7680' : 'db-f1-micro' },
    });

    new TerraformOutput(this, 'AuditBucketName', { value: this.bucket.name });

    // -- Governance -----------------------------------------------------------
    // Order matters: aspects run in the order added, once per node, depth-first.
    // Mutators first so validators see the final shape.
    const aspects = Aspects.of(this);
    aspects.add(new LabelsAspect({ labels: mandatoryTags(this.tier, 'governance') }));
    aspects.add(new StatefulProtectionAspect(this.tier));
    aspects.add(new NoPublicBucketsAspect());
    aspects.add(new RequireCmekAspect());
    aspects.add(new ConstructPolicyAspect([PascalCaseIds, maxDepthRule(6)]));
  }
}
