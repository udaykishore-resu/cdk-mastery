import { IAspect } from 'cdktf';
import { IConstruct } from 'constructs';
import { SqlDatabaseInstance } from '@cdktf/provider-google/lib/sql-database-instance';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { EnvironmentTier } from '@cdk-mastery/shared';

/**
 * Mutating aspect that protects stateful resources according to the tier, and
 * demonstrates the two ways an aspect can change a resource it did not build:
 *
 *  A. The typed surface. `TerraformResource.lifecycle` is a public mutable field
 *     and every argument has a setter, so `node.lifecycle = {...}` or
 *     `node.forceDestroy = false` is plain TypeScript. Prefer this: it is
 *     type-checked and it round-trips through `*Input` getters, so later aspects
 *     (and tests) can read what you wrote.
 *
 *  B. `addOverride(path, value)`. Writes into a raw override map that is
 *     deep-merged over the rendered JSON *after* `toTerraform()`. Use it when the
 *     key is not reachable through the typed API: a nested block attribute you do
 *     not want to rebuild wholesale (`settings.deletion_protection_enabled` lives
 *     inside Cloud SQL's `settings` block, which the bindings expose as an
 *     OutputReference, not a plain object), a brand-new provider argument the
 *     prebuilt bindings do not know yet, or a key with a name the generator
 *     mangled. Two consequences to remember:
 *       - nothing you write with addOverride is visible via `*Input` getters,
 *         so validating aspects that run later will not see it;
 *       - list values are *concatenated* with what is already rendered (see
 *         `deepMerge` in cdktf/lib/util.js), so overriding `lifecycle.ignore_changes`
 *         on a resource that already ignores something appends rather than replaces.
 *
 * Key-path syntax: dots separate nesting. Blocks that Terraform models as a
 * *list* of objects (`template.containers`) are rendered as JSON arrays, so you
 * index them numerically: `template.containers.0.image`. Blocks that are a
 * *single* nested object (`settings`, `encryption`) are rendered as JSON objects
 * in cdk.tf.json, so the path is `settings.tier` — NOT `settings.0.tier` as HCL
 * attribute references would suggest. Getting this wrong silently adds a bogus
 * `"0"` key that Terraform rejects at validate time, not at synth.
 */
export class StatefulProtectionAspect implements IAspect {
  constructor(private readonly tier: EnvironmentTier) {}

  visit(node: IConstruct): void {
    const protect = this.tier.retainStatefulResources;

    if (node instanceof StorageBucket) {
      // (A) typed surface. `prevent_destroy` makes `terraform destroy` (and any
      // plan that would replace the bucket) fail before touching the API.
      node.forceDestroy = !protect;
      node.lifecycle = { ...(node.lifecycle ?? {}), preventDestroy: protect };
      return;
    }

    if (node instanceof SqlDatabaseInstance) {
      // (A) `deletion_protection` is a top-level argument: Terraform-side guard.
      node.deletionProtection = protect;
      // (B) `settings.deletion_protection_enabled` is the *API-side* guard: it
      // survives someone running `terraform destroy` from a different working
      // copy where the Terraform-side flag is false. Reaching it through the
      // typed API means rebuilding the whole `settings` struct; an override is
      // one line and leaves the author's settings untouched.
      node.addOverride('settings.deletion_protection_enabled', protect);
    }
  }
}
