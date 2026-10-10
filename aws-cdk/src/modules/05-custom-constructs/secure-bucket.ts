import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * SecureBucket — an L3 that encodes "how we do buckets here".
 *
 * API design decisions, each of which is a convention worth copying:
 *   - Props are an interface of `readonly` fields with sensible defaults; the construct
 *     never mutates them. Required props are the ones with no safe default (here: none).
 *   - Choice-of-strategy props are enums or static-factory classes, never TypeScript unions
 *     (`'kms' | 'managed'` is fine in TS, but jsii cannot express unions of non-primitives
 *     and string unions become plain `string` in other languages).
 *   - The primary L2 is exposed as a public readonly member (`bucket`) so callers keep the
 *     full L2 surface for the 10% we did not wrap. `node.defaultChild` also points at it.
 *   - `grant*` and `metric*` are delegated, not re-implemented, so their semantics match
 *     the L2 exactly and IAM stays minimal.
 *   - Validation runs in `node.addValidation` (synth-time, aggregated) for things that
 *     depend on the finished tree, and in the constructor for things that make the object
 *     unusable (throw early). Warnings use `Annotations` with a stable, namespaced id so
 *     users can acknowledge them.
 */
export enum SecureBucketEncryption {
  /** SSE-KMS with a customer-managed key (created unless `encryptionKey` is given). Auditable, revocable, ~$1/month per key + API charges. */
  KMS = 'KMS',
  /** SSE-S3 (AES-256). Free, no key policy to manage, no CloudTrail key-usage trail. */
  S3_MANAGED = 'S3_MANAGED',
}

export interface SecureBucketLifecycle {
  /** Move current versions to Glacier Instant Retrieval after this long. @default - no transition */
  readonly transitionAfter?: cdk.Duration;
  /** Delete noncurrent versions after this long. @default 90 days */
  readonly expireNoncurrentAfter?: cdk.Duration;
  /** Abort incomplete multipart uploads after this long (they cost money silently). @default 7 days */
  readonly abortIncompleteMultipartAfter?: cdk.Duration;
}

export interface SecureBucketProps {
  /** Physical name. @default - CloudFormation-generated */
  readonly bucketName?: string;
  /** @default SecureBucketEncryption.KMS */
  readonly encryption?: SecureBucketEncryption;
  /** Key to use with KMS encryption. @default - a new key with rotation enabled */
  readonly encryptionKey?: kms.IKey;
  /** @default true */
  readonly versioned?: boolean;
  /** Where server access logs go. @default - a new log bucket owned by this construct */
  readonly accessLogsBucket?: s3.IBucket;
  /** Must end with '/'. @default `<construct id>/` */
  readonly accessLogsPrefix?: string;
  /** @default - noncurrent versions expire after 90 days, multipart uploads abort after 7 */
  readonly lifecycle?: SecureBucketLifecycle;
  /** @default RemovalPolicy.RETAIN — this construct exists to hold data */
  readonly removalPolicy?: cdk.RemovalPolicy;
}

export class SecureBucket extends Construct {
  readonly bucket: s3.Bucket;
  readonly accessLogsBucket: s3.IBucket;
  /** Present only with KMS encryption. */
  readonly encryptionKey?: kms.IKey;
  readonly encryption: SecureBucketEncryption;

  constructor(scope: Construct, id: string, props: SecureBucketProps = {}) {
    super(scope, id);

    // Constructor-time validation: cheap, local, makes the object unusable if wrong.
    const prefix = props.accessLogsPrefix ?? `${id}/`;
    if (!prefix.endsWith('/')) {
      throw new Error(`SecureBucket "${this.node.path}": accessLogsPrefix must end with "/" (got "${prefix}")`);
    }
    if (props.bucketName && !cdk.Token.isUnresolved(props.bucketName) && props.bucketName !== props.bucketName.toLowerCase()) {
      throw new Error(`SecureBucket "${this.node.path}": bucketName must be lowercase (got "${props.bucketName}")`);
    }

    this.encryption = props.encryption ?? SecureBucketEncryption.KMS;
    const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.RETAIN;
    const versioned = props.versioned ?? true;

    if (this.encryption === SecureBucketEncryption.KMS) {
      this.encryptionKey =
        props.encryptionKey ??
        new kms.Key(this, 'Key', {
          enableKeyRotation: true,
          description: `SSE-KMS key for ${this.node.path}`,
          removalPolicy,
        });
    } else {
      cdk.Annotations.of(this).addWarningV2(
        'cdk-mastery:SecureBucket.s3ManagedEncryption',
        'S3-managed encryption has no key policy and no key-usage audit trail; prefer KMS for regulated data.',
      );
    }

    this.accessLogsBucket =
      props.accessLogsBucket ??
      new s3.Bucket(this, 'AccessLogs', {
        encryption: s3.BucketEncryption.S3_MANAGED, // S3 log delivery cannot write to SSE-KMS buckets
        enforceSSL: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        lifecycleRules: [{ id: 'expire-logs', expiration: cdk.Duration.days(365) }],
        removalPolicy,
      });

    const lifecycle = props.lifecycle ?? {};
    const rules: s3.LifecycleRule[] = [
      {
        id: 'housekeeping',
        abortIncompleteMultipartUploadAfter: lifecycle.abortIncompleteMultipartAfter ?? cdk.Duration.days(7),
        noncurrentVersionExpiration: versioned ? (lifecycle.expireNoncurrentAfter ?? cdk.Duration.days(90)) : undefined,
      },
    ];
    if (lifecycle.transitionAfter) {
      rules.push({
        id: 'tier-current-versions',
        transitions: [{ storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: lifecycle.transitionAfter }],
      });
    }

    this.bucket = new s3.Bucket(this, 'Resource', {
      bucketName: props.bucketName,
      encryption: this.encryption === SecureBucketEncryption.KMS ? s3.BucketEncryption.KMS : s3.BucketEncryption.S3_MANAGED,
      encryptionKey: this.encryptionKey,
      bucketKeyEnabled: this.encryption === SecureBucketEncryption.KMS, // cuts KMS API calls ~99%
      versioned,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: prefix,
      lifecycleRules: rules,
      removalPolicy,
      autoDeleteObjects: removalPolicy === cdk.RemovalPolicy.DESTROY,
    });

    // Synth-time validation: sees the final props, aggregates with every other validation.
    this.node.addValidation({
      validate: () => {
        const errors: string[] = [];
        if (lifecycle.transitionAfter && lifecycle.expireNoncurrentAfter && lifecycle.expireNoncurrentAfter.toDays() <= lifecycle.transitionAfter.toDays()) {
          errors.push(`expireNoncurrentAfter (${lifecycle.expireNoncurrentAfter.toDays()}d) must be greater than transitionAfter (${lifecycle.transitionAfter.toDays()}d)`);
        }
        if (removalPolicy === cdk.RemovalPolicy.DESTROY && versioned) {
          // Not an error — but a construct-level warning added here shows validations can annotate too.
          cdk.Annotations.of(this).addWarningV2(
            'cdk-mastery:SecureBucket.destroyVersioned',
            'RemovalPolicy.DESTROY with versioning: `cdk destroy` will delete all versions via the auto-delete custom resource.',
          );
        }
        return errors;
      },
    });
  }

  // --- grant*: delegate, do not reimplement ------------------------------------------------
  grantRead(grantee: iam.IGrantable, objectsKeyPattern: string = '*'): iam.Grant {
    return this.bucket.grantRead(grantee, objectsKeyPattern);
  }

  grantWrite(grantee: iam.IGrantable, objectsKeyPattern: string = '*'): iam.Grant {
    return this.bucket.grantWrite(grantee, objectsKeyPattern);
  }

  // --- metric*: S3 storage metrics are daily; period must be >= 1 day to see data -----------
  metricNumberOfObjects(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.storageMetric('NumberOfObjects', 'AllStorageTypes', props);
  }

  metricBucketSizeBytes(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.storageMetric('BucketSizeBytes', 'StandardStorage', props);
  }

  private storageMetric(metricName: string, storageType: string, props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: 'AWS/S3',
      metricName,
      dimensionsMap: { BucketName: this.bucket.bucketName, StorageType: storageType },
      statistic: cloudwatch.Stats.AVERAGE,
      period: cdk.Duration.days(1),
      ...props,
    });
  }
}
