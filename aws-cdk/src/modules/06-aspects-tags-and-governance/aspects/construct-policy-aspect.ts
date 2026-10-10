import * as cdk from 'aws-cdk-lib';
import { ConstructPolicy, ConstructRule } from '@cdk-mastery/shared';
import { IConstruct } from 'constructs';

export interface ConstructPolicyAspectOptions {
  /**
   * Nodes for which the policy is skipped. Typical use: the root the policy is
   * applied to, whose id is owned by whoever calls `addToApp` (this curriculum
   * names stacks `M06-Governed`, which is not PascalCase and is not a logical ID
   * either — stack ids become stack *names*, not template identifiers).
   */
  readonly exclude?: (node: IConstruct) => boolean;
}

/**
 * Bridge between the framework-agnostic `ConstructPolicy` (shared/src/policy.ts)
 * and AWS CDK's `IAspect`.
 *
 * `ConstructPolicy` already has a structurally compatible `visit(node)`; you could
 * hand it straight to `Aspects.of(app).add(policy)`. What it lacks is a way to
 * *surface* violations that fits CDK's pipeline: it accumulates them in an array
 * and offers `throwIfViolated()`. Throwing during the aspect walk would stop at
 * the first violation. This bridge translates every new violation into an
 * `Annotations.addError` on the offending node, so `cdk synth` lists all of them
 * and tests can assert on them per path.
 *
 * The delta trick (`before`/`after` lengths) works because `ConstructPolicy.visit`
 * appends synchronously and never removes.
 */
export class ConstructPolicyAspect implements cdk.IAspect {
  readonly policy: ConstructPolicy;

  constructor(rules: ConstructRule[], private readonly options: ConstructPolicyAspectOptions = {}) {
    this.policy = new ConstructPolicy(rules);
  }

  visit(node: IConstruct): void {
    if (this.options.exclude?.(node)) return;
    const before = this.policy.violations.length;
    this.policy.visit(node);
    for (const v of this.policy.violations.slice(before)) {
      cdk.Annotations.of(node).addError(`[${v.rule}] ${v.message}`);
    }
  }
}
