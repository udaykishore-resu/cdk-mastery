import { Annotations, Token } from 'cdktf';
import { Construct, IConstruct } from 'constructs';
import { StorageBucket, StorageBucketLifecycleRule } from '@cdktf/provider-google/lib/storage-bucket';
import { StorageBucketIamMember } from '@cdktf/provider-google/lib/storage-bucket-iam-member';
import { KmsCryptoKey } from '@cdktf/provider-google/lib/kms-crypto-key';
import { KmsCryptoKeyIamMember } from '@cdktf/provider-google/lib/kms-crypto-key-iam-member';
import { DataGoogleStorageProjectServiceAccount } from '@cdktf/provider-google/lib/data-google-storage-project-service-account';
import { EnvironmentTier, mandatoryTags } from '@cdk-mastery/shared';

/**
 * The *interface* is what consumers depend on. Mirrors AWS CDK's `IBucket`:
 * anything that can hand out a name and grant access qualifies, whether we
 * created it (`SecureBucket`) or merely know its name (exercise 1's
 * `SecureBucket.fromBucketName`-style import).
 */
export interface ISecureBucket extends IConstruct {
  readonly bucketName: string;
  /** `gs://<name>` */
  readonly bucketUrl: string;
  grantRead(id: string, member: string): StorageBucketIamMember;
  grantWrite(id: string, member: string): StorageBucketIamMember;
}

export interface SecureBucketProps {
  readonly tier: EnvironmentTier;
  /** Globally unique bucket name. Validated at synth when it is not a token. */
  readonly name: string;
  readonly location: string;
  /** Component label (`service` in mandatoryTags). */
  readonly service: string;
  /** Customer-managed encryption key. When set, the GCS service agent is granted use of it. */
  readonly encryptionKey?: KmsCryptoKey;
  /** Project id, needed to resolve the GCS service agent when `encryptionKey` is set. */
  readonly project?: string;
  /** Delete non-current versions after this many days. Defaults to the tier's log retention. */
  readonly noncurrentVersionRetentionDays?: number;
  /** Extra lifecycle rules appended after the built-in ones. */
  readonly lifecycleRules?: StorageBucketLifecycleRule[];
  /** Bucket that receives access logs. Absent = no access logging (warned in prod). */
  readonly accessLogsBucket?: ISecureBucket;
  /** Only honoured outside prod; in prod it is an error. */
  readonly forceDestroy?: boolean;
  readonly labels?: Record<string, string>;
}

/**
 * A bucket with the settings a security review expects, as one construct:
 * uniform access, versioning, public-access prevention enforced, lifecycle
 * for old versions, optional CMEK, optional access logging.
 *
 * Design rules (they mirror AWS CDK's L2 conventions on purpose):
 *   - props are an interface with `readonly` fields and sensible defaults;
 *   - the class exposes an `I*` interface and `grant*` helpers that create
 *     additive IAM members in *this* scope (so they are deleted with the bucket);
 *   - validation happens in two channels: `node.addValidation` (hard errors,
 *     surfaced by `Testing.synth(stack, true)` and by `cdktf synth`) and
 *     `Annotations` (warnings that reach the manifest, errors that abort synth).
 */
export class SecureBucket extends Construct implements ISecureBucket {
  readonly bucket: StorageBucket;
  readonly bucketName: string;
  readonly bucketUrl: string;

  constructor(scope: Construct, id: string, props: SecureBucketProps) {
    super(scope, id);
    const tier = props.tier;
    const retentionDays = props.noncurrentVersionRetentionDays ?? tier.logRetentionDays;
    const forceDestroy = props.forceDestroy ?? !tier.retainStatefulResources;

    // Hard validation: runs at synth, reports every failure at once.
    this.node.addValidation({
      validate: () => {
        const errors: string[] = [];
        if (!Token.isUnresolved(props.name) && !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(props.name)) {
          errors.push(`bucket name "${props.name}" must be 3-63 chars of [a-z0-9._-] and start/end alphanumeric`);
        }
        if (!Number.isInteger(retentionDays) || retentionDays < 1) {
          errors.push(`noncurrentVersionRetentionDays must be a positive integer, got ${retentionDays}`);
        }
        if (props.encryptionKey && !props.project) {
          errors.push('project is required when encryptionKey is set (to resolve the GCS service agent)');
        }
        return errors;
      },
    });

    // Annotations: an error aborts synth (App.synth / fullSynth); a warning is
    // recorded in manifest.json and printed by the CLI.
    if (tier.retainStatefulResources && props.forceDestroy) {
      Annotations.of(this).addError(`forceDestroy is not allowed in ${tier.name}`);
    }
    if (tier.retainStatefulResources && !props.accessLogsBucket) {
      Annotations.of(this).addWarning('prod buckets should ship access logs (accessLogsBucket)');
    }

    if (props.encryptionKey && props.project) {
      // CMEK: GCS encrypts with *its* service agent, which must be allowed to use the key.
      const agent = new DataGoogleStorageProjectServiceAccount(this, 'StorageAgent', { project: props.project });
      const keyUse = new KmsCryptoKeyIamMember(this, 'StorageAgentUsesKey', {
        cryptoKeyId: props.encryptionKey.id,
        role: 'roles/cloudkms.cryptoKeyEncrypterDecrypter',
        member: `serviceAccount:${agent.emailAddress}`,
      });
      this.bucket = this.createBucket(props, forceDestroy, retentionDays, { defaultKmsKeyName: props.encryptionKey.id }, [keyUse]);
    } else {
      this.bucket = this.createBucket(props, forceDestroy, retentionDays);
    }

    this.bucketName = this.bucket.name;
    this.bucketUrl = this.bucket.url;
  }

  private createBucket(
    props: SecureBucketProps,
    forceDestroy: boolean,
    retentionDays: number,
    encryption?: { defaultKmsKeyName: string },
    dependsOn?: KmsCryptoKeyIamMember[],
  ): StorageBucket {
    return new StorageBucket(this, 'Bucket', {
      name: props.name,
      location: props.location,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: 'enforced',
      versioning: { enabled: true },
      forceDestroy,
      encryption,
      dependsOn,
      logging: props.accessLogsBucket ? { logBucket: props.accessLogsBucket.bucketName, logObjectPrefix: props.name } : undefined,
      lifecycleRule: [
        { action: { type: 'Delete' }, condition: { daysSinceNoncurrentTime: retentionDays, withState: 'ARCHIVED' } },
        { action: { type: 'Delete' }, condition: { numNewerVersions: 5, withState: 'ARCHIVED' } },
        { action: { type: 'AbortIncompleteMultipartUpload' }, condition: { age: 7 } },
        ...(props.lifecycleRules ?? []),
      ],
      labels: { ...mandatoryTags(props.tier, props.service), ...(props.labels ?? {}) },
    });
  }

  grantRead(id: string, member: string): StorageBucketIamMember {
    return new StorageBucketIamMember(this, id, { bucket: this.bucket.name, role: 'roles/storage.objectViewer', member });
  }

  grantWrite(id: string, member: string): StorageBucketIamMember {
    // objectUser (not objectAdmin): create/read/delete objects, no bucket-level IAM changes.
    return new StorageBucketIamMember(this, id, { bucket: this.bucket.name, role: 'roles/storage.objectUser', member });
  }
}
