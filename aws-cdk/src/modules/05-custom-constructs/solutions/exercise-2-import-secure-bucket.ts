import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Exercise 2 — an `ISecureBucket` interface and `fromSecureBucketAttributes`.
 *
 * What must be on the interface: only what works on an imported bucket. `grantRead` on an
 * imported bucket produces the same IAM statements as on an owned one (the grantee's
 * policy is where they land), *if* the key ARN is known — otherwise KMS permissions are
 * missing and reads fail at runtime with AccessDenied on kms:Decrypt. That is why the
 * attributes carry `encryptionKeyArn` and why `grantRead` warns when it is absent.
 */
export interface ISecureBucket {
  readonly bucket: s3.IBucket;
  readonly encryptionKey?: kms.IKey;
  grantRead(grantee: iam.IGrantable, objectsKeyPattern?: string): iam.Grant;
  grantWrite(grantee: iam.IGrantable, objectsKeyPattern?: string): iam.Grant;
  metricNumberOfObjects(props?: cloudwatch.MetricOptions): cloudwatch.Metric;
}

export interface SecureBucketAttributes {
  readonly bucketArn: string;
  /** ARN of the SSE-KMS key. Omit for SSE-S3 buckets. */
  readonly encryptionKeyArn?: string;
}

export class ImportedSecureBucket extends Construct implements ISecureBucket {
  readonly bucket: s3.IBucket;
  readonly encryptionKey?: kms.IKey;

  constructor(scope: Construct, id: string, attrs: SecureBucketAttributes) {
    super(scope, id);
    this.encryptionKey = attrs.encryptionKeyArn ? kms.Key.fromKeyArn(this, 'Key', attrs.encryptionKeyArn) : undefined;
    // Passing the key to fromBucketAttributes is what makes grant* include kms:Decrypt/Encrypt.
    this.bucket = s3.Bucket.fromBucketAttributes(this, 'Resource', { bucketArn: attrs.bucketArn, encryptionKey: this.encryptionKey });
    if (!this.encryptionKey) {
      cdk.Annotations.of(this).addWarningV2(
        'cdk-mastery:ImportedSecureBucket.noKey',
        'Imported without encryptionKeyArn: grants will not include KMS permissions. Fine for SSE-S3 buckets, broken for SSE-KMS ones.',
      );
    }
  }

  grantRead(grantee: iam.IGrantable, objectsKeyPattern: string = '*'): iam.Grant {
    return this.bucket.grantRead(grantee, objectsKeyPattern);
  }

  grantWrite(grantee: iam.IGrantable, objectsKeyPattern: string = '*'): iam.Grant {
    return this.bucket.grantWrite(grantee, objectsKeyPattern);
  }

  metricNumberOfObjects(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: 'AWS/S3',
      metricName: 'NumberOfObjects',
      dimensionsMap: { BucketName: this.bucket.bucketName, StorageType: 'AllStorageTypes' },
      statistic: cloudwatch.Stats.AVERAGE,
      period: cdk.Duration.days(1),
      ...props,
    });
  }
}

export function fromSecureBucketAttributes(scope: Construct, id: string, attrs: SecureBucketAttributes): ISecureBucket {
  return new ImportedSecureBucket(scope, id, attrs);
}
