import * as cdk from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

/**
 * The 500-resource limit and how to stay under it.
 *
 * CloudFormation caps a template at 500 resources (and 1 MB, 200 parameters, 200 outputs,
 * 200 mappings). L2s hide how many resources they create: one `Vpc` with 2 AZs, NAT and
 * endpoints is ~35; a `NodejsFunction` with a log group, alias and canary is ~8; an ECS
 * pattern is ~20. A "single service stack" reaches 500 faster than people expect.
 *
 * Strategies, in the order you should try them:
 *   1. Split by lifecycle: stateful vs stateless (this module), then by team ownership.
 *   2. Split by cardinality: one stack per tenant/queue/region shard, generated in a loop
 *      with a stable id scheme (`Shard0`, `Shard1`, …) so adding a shard never renumbers.
 *   3. Nested stacks when the unit must deploy atomically with its parent.
 *   4. Reduce resource count: `iam:minimizePolicies` (on in cdk.json) merges IAM statements;
 *      shared log groups; one `LogRetention` custom resource instead of per-function.
 *
 * `ResourceBudget` is an Aspect that counts CfnResources per stack and annotates a warning
 * at `warnAt` and an error at `limit`. Errors fail `cdk synth`, so a stack cannot creep past
 * the limit unnoticed in CI.
 */
export interface ResourceBudgetProps {
  /** Hard limit; CloudFormation's is 500. Configurable so tests can exercise it. */
  readonly limit?: number;
  /** Warn at this count (default: 80% of limit). */
  readonly warnAt?: number;
}

export class ResourceBudget implements cdk.IAspect {
  private readonly limit: number;
  private readonly warnAt: number;

  constructor(props: ResourceBudgetProps = {}) {
    this.limit = props.limit ?? 500;
    this.warnAt = props.warnAt ?? Math.floor(this.limit * 0.8);
  }

  visit(node: IConstruct): void {
    // Only act once per stack; nested stacks are separate templates with their own budget.
    if (!cdk.Stack.isStack(node)) return;
    const count = countResources(node);
    if (count > this.limit) {
      cdk.Annotations.of(node).addError(`Stack has ${count} resources; CloudFormation allows ${this.limit}. Split the stack (see module 02).`);
    } else if (count >= this.warnAt) {
      cdk.Annotations.of(node).addWarningV2('cdk-mastery:ResourceBudget.nearLimit', `Stack has ${count} resources (warning threshold ${this.warnAt}, limit ${this.limit}).`);
    }
  }
}

/** Resources rendered into THIS stack's template — nested stacks' children excluded. */
export function countResources(stack: cdk.Stack): number {
  let n = 0;
  for (const c of stack.node.findAll()) {
    if (cdk.CfnResource.isCfnResource(c) && cdk.Stack.of(c) === stack) n += 1;
  }
  return n;
}
