import { Annotations, IAspect, TerraformBackend, TerraformStack } from 'cdktf';
import { IConstruct } from 'constructs';
import { ConstructPolicy, ConstructRule } from '@cdk-mastery/shared';

export interface ConstructPolicyAspectProps {
  /**
   * Nodes to leave alone. Defaults to `isFrameworkManagedId`: stacks (ids are
   * lowercase kebab by this track's contract: they become directory names under
   * `cdktf.out/stacks/` and state-file names), backends (cdktf names the node
   * `backend`) and the `cross-stack-output-*` / `cross-stack-reference-input-*`
   * elements cdktf creates for cross-stack references. None of those ids are
   * chosen by the author, so a naming rule must not see them.
   */
  readonly skip?: (node: IConstruct) => boolean;
}

/** Ids cdktf assigns itself; not subject to house naming rules. */
export function isFrameworkManagedId(node: IConstruct): boolean {
  return TerraformStack.isStack(node) || node instanceof TerraformBackend || node.node.id.startsWith('cross-stack-');
}

/**
 * Bridges the framework-agnostic `ConstructPolicy` (shared/src/policy.ts) into
 * CDKTF's `Aspects` machinery.
 *
 * `ConstructPolicy.visit(node)` already has the `{ visit(node: IConstruct) }`
 * shape of `IAspect`, so `Aspects.of(stack).add(policy)` compiles and runs. What
 * it does NOT do is *report*: it silently fills `policy.violations`, and unless
 * someone calls `throwIfViolated()` after synthesis the run is green. This
 * wrapper turns every violation into an `Annotations` error on the offending
 * node, so the failure lands in `manifest.json` next to the construct path and
 * aborts `cdktf synth` like any other governance error.
 *
 * Why not just call `throwIfViolated()` inside `visit`? Because aspects are
 * invoked per node, and throwing on the first violation hides the rest. Errors
 * via Annotations are collected across the whole tree and printed together.
 *
 * Re-entrancy: every `Testing.synth` / `Testing.fullSynth` / `app.synth` call
 * re-runs all aspects from scratch (the "already invoked" bookkeeping in
 * `invokeAspects` is per call). A validating aspect that is not idempotent
 * reports each violation once per synth. The `reported` set below makes this
 * one idempotent; write your own aspects the same way.
 */
export class ConstructPolicyAspect implements IAspect {
  readonly policy: ConstructPolicy;
  private readonly skip: (node: IConstruct) => boolean;
  private readonly reported = new Set<string>();

  constructor(rules: ConstructRule[], props: ConstructPolicyAspectProps = {}) {
    this.policy = new ConstructPolicy(rules);
    this.skip = props.skip ?? isFrameworkManagedId;
  }

  visit(node: IConstruct): void {
    if (this.skip(node)) return;
    const before = this.policy.violations.length;
    this.policy.visit(node);
    for (const v of this.policy.violations.slice(before)) {
      const key = `${v.path}#${v.rule}`;
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      Annotations.of(node).addError(`[${v.rule}] ${v.message}`);
    }
  }
}
