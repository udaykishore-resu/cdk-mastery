import * as cdk from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

export interface CfnLintIgnoreAspectProps {
  /** CloudFormation resource type → cfn-lint rule ids to ignore on it. */
  readonly ignoreByType: Record<string, string[]>;
}

/**
 * Exercise 1 — escape hatches at fleet scale.
 *
 * cfn-lint reads `Metadata.cfn-lint.config.ignore_checks` on a resource. Adding
 * that by hand to every bucket is exactly the kind of repetition aspects exist
 * for, and `addOverride` on `Metadata.*` is the only way to put arbitrary keys
 * there (L2s do not model Metadata beyond `aws:cdk:path`). Two details:
 *
 *  - Overrides on a path *merge* into the rendered object: existing Metadata
 *    (`aws:cdk:path`, `cdk_nag`) is preserved.
 *  - This is a mutating aspect, so register it at `AspectPriority.MUTATING`; a
 *    validation plugin or a linter that reads the template afterwards sees it.
 */
export class CfnLintIgnoreAspect implements cdk.IAspect {
  constructor(private readonly props: CfnLintIgnoreAspectProps) {}

  visit(node: IConstruct): void {
    if (!cdk.CfnResource.isCfnResource(node)) return;
    const rules = this.props.ignoreByType[node.cfnResourceType];
    if (!rules || rules.length === 0) return;
    node.addOverride('Metadata.cfn-lint.config.ignore_checks', rules);
  }
}
