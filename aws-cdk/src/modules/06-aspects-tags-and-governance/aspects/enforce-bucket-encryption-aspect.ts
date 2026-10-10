import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { IConstruct } from 'constructs';

export interface EnforceBucketEncryptionAspectProps {
  /**
   * KMS key ARN to use for SSE-KMS. When omitted the aspect applies SSE-S3 (AES256),
   * which is what S3 does by default since January 2023 anyway — but *explicit* is
   * what auditors and cdk-nag look for.
   */
  readonly kmsKeyArn?: string;
}

/**
 * A MUTATING aspect: it edits L1 properties on every `AWS::S3::Bucket` in scope.
 *
 * Why an aspect and not a construct default? Because the bucket may come from a
 * third-party construct library that never exposed `encryption`, or from
 * `cloudformation-include`. Aspects are the only hook that sees *every* node after
 * the whole tree has been built and before anything is rendered.
 *
 * Why L1 (`CfnBucket`) and not L2 (`Bucket`)? Aspects run after construction;
 * an L2's props have already been consumed. The only thing still writable at that
 * point is the L1's property bag, which is what synthesis renders.
 */
export class EnforceBucketEncryptionAspect implements cdk.IAspect {
  constructor(private readonly props: EnforceBucketEncryptionAspectProps = {}) {}

  visit(node: IConstruct): void {
    // Narrow by class, not by string type — `instanceof` survives refactors and
    // gives you the typed property bag. `CfnResource.isCfnResource(node) &&
    // node.cfnResourceType === 'AWS::S3::Bucket'` is the fallback for L1s you did
    // not import (e.g. produced by CfnInclude), see NoPublicBucketsAspect.
    if (!(node instanceof s3.CfnBucket)) return;
    if (node.bucketEncryption !== undefined) return; // respect explicit choices

    const rule: s3.CfnBucket.ServerSideEncryptionRuleProperty = this.props.kmsKeyArn
      ? {
          serverSideEncryptionByDefault: { sseAlgorithm: 'aws:kms', kmsMasterKeyId: this.props.kmsKeyArn },
          bucketKeyEnabled: true, // S3 Bucket Keys cut KMS request cost by ~99% for high-throughput buckets
        }
      : { serverSideEncryptionByDefault: { sseAlgorithm: 'AES256' } };

    // Assigning to an L1 property after construction is legal: L1 props are plain
    // writable fields that are rendered lazily at synth time.
    node.bucketEncryption = { serverSideEncryptionConfiguration: [rule] };
    cdk.Annotations.of(node).addInfo(
      `EnforceBucketEncryptionAspect: applied ${this.props.kmsKeyArn ? 'SSE-KMS' : 'SSE-S3'} encryption`,
    );
  }
}
