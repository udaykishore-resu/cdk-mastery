import * as cdk from 'aws-cdk-lib';
import { Construct, IConstruct } from 'constructs';

/**
 * A construct that records which synthesis phase touched it, and in what order.
 *
 * `cdk synth` (and `Template.fromStack` in tests) drives the app through these phases
 * (see `aws-cdk-lib/core/lib/private/synthesis.js`, function `synthesize`):
 *
 *   1. construct   — your constructors run, top-down, building the tree. Nothing is
 *                    rendered yet; property values may still be tokens.
 *   2. prepare     — (a) `Aspects` are invoked: the tree is walked and every aspect visits
 *                    every node under the scope it was added to. Last chance to mutate.
 *                    (b) `prepareApp` resolves cross-stack references. To find them it has
 *                    to *render every L1 once*, so tokens — including `Lazy` producers —
 *                    are evaluated for the first time HERE, before validation.
 *   3. validate    — every `node.addValidation({ validate() })` runs; a non-empty array of
 *                    messages fails synthesis. The tree is frozen (`node.lock()`).
 *   4. synthesize  — every stack's `_toCloudFormation()` renders its L1s again, this time
 *                    into `cdk.out`. Tokens are resolved a second time.
 *
 * Each phase pushes a marker into `events`, and the marker list is written into the SSM
 * parameter's value so the order is visible in the synthesized template, not just in
 * memory. `Lazy.uncachedString` is deliberate: the cached `Lazy.string` would freeze the
 * value produced in phase 2(b) and hide phases 3 and 4 from the template.
 */
export class LifecyclePhases extends Construct {
  readonly events: string[] = [];
  private produced = 0;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.record('construct');

    new cdk.CfnResource(this, 'Resource', {
      type: 'AWS::SSM::Parameter',
      properties: {
        Type: 'String',
        Name: `/cdk-mastery/lifecycle/${cdk.Names.uniqueId(this)}`,
        Value: cdk.Lazy.uncachedString({
          produce: () => {
            this.produced += 1;
            // First evaluation happens while prepareApp hunts for cross-stack references;
            // the second one is the real render into the template.
            this.record(this.produced === 1 ? 'prepare:resolve-references' : 'synthesize');
            return this.events.join(' -> ');
          },
        }),
      },
    });

    // Phase 2(a). Aspects added to a scope visit that scope and everything beneath it.
    cdk.Aspects.of(this).add({
      visit: (node: IConstruct) => {
        if (node === this) this.record('prepare:aspects');
      },
    });

    // Phase 3. Returning [] means "valid"; returning strings fails the synth with those messages.
    this.node.addValidation({
      validate: () => {
        this.record('validate');
        return [];
      },
    });
  }

  /** Idempotent so repeated token evaluation cannot duplicate a phase. */
  private record(phase: string): void {
    if (!this.events.includes(phase)) this.events.push(phase);
  }
}
