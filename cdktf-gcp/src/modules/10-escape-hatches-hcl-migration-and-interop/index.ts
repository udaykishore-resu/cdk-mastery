import { App } from 'cdktf';
import { ConvertedStack } from './converted';
import { InteropStack } from './interop-stack';
import { OverridesStack } from './overrides-stack';
import { RefactorStack } from './refactor-stack';

export * from './gcp-config';
export * from './overrides-stack';
export * from './refactor-stack';
export * from './interop-stack';
export * from './converted';

/**
 * Four stacks, four situations:
 *   m10-overrides  the escape-hatch ladder
 *   m10-refactor   import / moved blocks — registered only when CDKM_ENABLE_REFACTOR_STACK is set,
 *                  because `moved`/`import` blocks add a `terraform version` check (>= 1.5) that runs
 *                  during `app.synth()` and fails on a machine without a Terraform/OpenTofu binary.
 *   m10-interop    remote state, registry module, asset, variable
 *   m10-converted  legacy/main.tf as CDKTF, addresses pinned to the HCL names
 */
export function addToApp(app: App): void {
  new OverridesStack(app, 'm10-overrides', { tier: 'dev' });
  if (process.env.CDKM_ENABLE_REFACTOR_STACK) new RefactorStack(app, 'm10-refactor', { tier: 'dev' });
  new InteropStack(app, 'm10-interop', { tier: 'dev' });
  new ConvertedStack(app, 'm10-converted', { keepBackend: !!process.env.CDKM_STATE_BUCKET });
}
