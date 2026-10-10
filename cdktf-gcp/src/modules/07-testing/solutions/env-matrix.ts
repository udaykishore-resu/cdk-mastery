import { App, TerraformStack, Testing } from 'cdktf';
import { ENVIRONMENTS, EnvironmentName, EnvironmentTier } from '@cdk-mastery/shared';

/**
 * Exercise 3 (hard): a table-driven harness that synthesizes a stack factory for
 * every tier in `ENVIRONMENTS` and hands back parsed JSON per tier, so a test
 * can assert *differences between tiers* (the thing that actually goes wrong:
 * "prod lost deletion protection in a refactor") rather than one tier at a time.
 *
 * `prepare` runs `stack.prepareStack()` first, which is what wires cross-stack
 * references (module 02); harmless for single stacks.
 */
export interface EnvSynth<T extends TerraformStack> {
  readonly tier: EnvironmentTier;
  readonly stack: T;
  readonly json: Record<string, any>;
}

export type StackFactory<T extends TerraformStack> = (app: App, tier: EnvironmentTier) => T;

export function synthAllEnvironments<T extends TerraformStack>(factory: StackFactory<T>, names: EnvironmentName[] = Object.keys(ENVIRONMENTS) as EnvironmentName[]): Record<EnvironmentName, EnvSynth<T>> {
  const out = {} as Record<EnvironmentName, EnvSynth<T>>;
  for (const name of names) {
    const tier = ENVIRONMENTS[name];
    const app = Testing.app();
    const stack = factory(app, tier);
    stack.prepareStack();
    out[name] = { tier, stack, json: JSON.parse(Testing.synth(stack)) };
  }
  return out;
}

/**
 * Read a dotted path (`resource.google_pubsub_topic.Orders.message_retention_duration`)
 * from a synthesized stack. Returns undefined instead of throwing so a test can
 * assert `expect(get(dev, ...)).toBeUndefined()`.
 */
export function get(json: Record<string, any>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), json);
}

/**
 * Diff two tiers at a path. Returns `{ same: true }` or both values, so the
 * assertion message names the tier that drifted.
 */
export function compareTiers(a: EnvSynth<TerraformStack>, b: EnvSynth<TerraformStack>, path: string): { same: boolean; [tier: string]: unknown } {
  const va = get(a.json, path);
  const vb = get(b.json, path);
  return { same: JSON.stringify(va) === JSON.stringify(vb), [a.tier.name]: va, [b.tier.name]: vb };
}
