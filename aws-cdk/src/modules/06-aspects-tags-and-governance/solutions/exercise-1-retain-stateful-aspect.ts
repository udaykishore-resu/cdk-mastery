import * as cdk from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

/**
 * Exercise 1 — read-only aspect: every *stateful* resource must carry
 * `DeletionPolicy: Retain` (and `UpdateReplacePolicy: Retain`) in tiers that
 * retain state. Report a warning, not an error, because dev tiers legitimately
 * destroy.
 *
 * Why inspect `cfnOptions` and not the rendered template? Because at aspect
 * time there *is* no template yet; `cfnOptions.deletionPolicy` is the field
 * `applyRemovalPolicy()` writes and synthesis reads.
 */
export const STATEFUL_TYPES = new Set([
  'AWS::S3::Bucket',
  'AWS::DynamoDB::Table',
  'AWS::DynamoDB::GlobalTable',
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBCluster',
  'AWS::KMS::Key',
  'AWS::Logs::LogGroup',
  'AWS::SQS::Queue',
]);

export interface RetainStatefulAspectProps {
  /** When false the aspect is a no-op — pass `tier.retainStatefulResources`. */
  readonly enforce: boolean;
  /** Emit errors instead of warnings (prod). */
  readonly asError?: boolean;
}

export class RetainStatefulAspect implements cdk.IAspect {
  constructor(private readonly props: RetainStatefulAspectProps) {}

  visit(node: IConstruct): void {
    if (!this.props.enforce) return;
    if (!cdk.CfnResource.isCfnResource(node) || !STATEFUL_TYPES.has(node.cfnResourceType)) return;

    const deletion = node.cfnOptions.deletionPolicy;
    const replace = node.cfnOptions.updateReplacePolicy;
    if (deletion === cdk.CfnDeletionPolicy.RETAIN && replace === cdk.CfnDeletionPolicy.RETAIN) return;

    const message =
      `RetainStatefulAspect: ${node.cfnResourceType} has DeletionPolicy=${deletion ?? 'Delete'} ` +
      `UpdateReplacePolicy=${replace ?? 'Delete'}; stateful resources in this tier must use RemovalPolicy.RETAIN`;
    if (this.props.asError) cdk.Annotations.of(node).addError(message);
    else cdk.Annotations.of(node).addWarning(message);
  }
}
