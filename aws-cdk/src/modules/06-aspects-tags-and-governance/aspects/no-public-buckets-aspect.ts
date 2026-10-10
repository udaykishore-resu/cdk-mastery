import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { IConstruct } from 'constructs';

/**
 * READ-ONLY (validating) aspect: every `AWS::S3::Bucket` must block all four
 * public-access vectors. It never edits the tree; it only *reports* through
 * `Annotations`, which is the contract for anything applied at READONLY priority.
 *
 * Why `addError` instead of `throw`?
 *  - `throw` inside an aspect aborts the walk at the first offender and hides the
 *    rest. `addError` attaches a metadata entry to the offending node, synthesis
 *    keeps going, and `cdk synth` prints *all* errors then exits non-zero.
 *  - Tests can read them with `Annotations.fromStack(stack).hasError(path, msg)`
 *    without wrapping anything in `expect(...).toThrow`.
 *  - With `@aws-cdk/core:annotationsInValidationReport` (on in this repo's cdk.json),
 *    the same errors also land in `cdk.out/validation-report.json` next to cdk-nag
 *    findings, so one report covers house rules and vendor rules.
 *
 * Matching by `cfnResourceType` (a string) rather than `instanceof CfnBucket` is
 * deliberate here: buckets adopted through `cloudformation-include` *are*
 * `CfnBucket` instances, but a bucket produced by a construct library compiled
 * against a different copy of aws-cdk-lib would fail `instanceof`. The string check
 * is the robust one for a governance rule; the typed cast afterwards is safe
 * because the L1 shape for a given resource type is stable.
 */
export class NoPublicBucketsAspect implements cdk.IAspect {
  visit(node: IConstruct): void {
    if (!cdk.CfnResource.isCfnResource(node) || node.cfnResourceType !== 'AWS::S3::Bucket') return;
    const bucket = node as s3.CfnBucket;

    // The property may be an IResolvable (e.g. produced by CfnInclude or a Lazy).
    // Resolve through the stack so intrinsics are expanded before we inspect.
    const pab = cdk.Stack.of(node).resolve(bucket.publicAccessBlockConfiguration) as
      | s3.CfnBucket.PublicAccessBlockConfigurationProperty
      | undefined;

    const flags = [
      pab?.blockPublicAcls,
      pab?.blockPublicPolicy,
      pab?.ignorePublicAcls,
      pab?.restrictPublicBuckets,
    ];
    if (flags.every((f) => f === true)) return;

    cdk.Annotations.of(node).addError(
      'NoPublicBucketsAspect: bucket must set all four PublicAccessBlockConfiguration flags to true ' +
        '(use `blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL`)',
    );
  }
}
