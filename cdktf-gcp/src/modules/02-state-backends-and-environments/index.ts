import { App } from 'cdktf';
import { AppStack } from './app-stack';
import { addEnvironmentStacks } from './environments';
import { NetworkStack } from './network-stack';
import { RefactorStack } from './state-surgery';

export * from './backend';
export * from './gcp-config';
export * from './network-stack';
export * from './app-stack';
export * from './environments';
export * from './state-surgery';

/**
 * Stacks: m02-network → m02-app (cross-stack reference), m02-env-{dev,staging,prod}
 * (stack-per-environment), and — only when `CDKM_ENABLE_REFACTOR_STACK` is set —
 * m02-refactor (moved/import blocks).
 *
 * `CDKM_STATE_BUCKET` switches every stack to a GCS backend; unset, they use
 * local state so synth works anywhere. `CDKM_LEGACY_STATE_BUCKET` (optional)
 * makes m02-app also read an HCL-managed stack's outputs.
 *
 * The refactor stack is gated because `moveTo`/`importFrom` register a
 * `ValidateTerraformVersion(">=1.5")` validation that shells out to the
 * Terraform binary during `app.synth()`; without a binary on PATH synth fails.
 * The tests cover it through `Testing.synth`, which does not run validations.
 */
export function addToApp(app: App): void {
  const network = new NetworkStack(app, 'm02-network', { tier: 'dev' });
  const legacyBucket = process.env.CDKM_LEGACY_STATE_BUCKET;
  new AppStack(app, 'm02-app', {
    tier: 'dev',
    network,
    legacyState: legacyBucket ? { bucket: legacyBucket, prefix: process.env.CDKM_LEGACY_STATE_PREFIX ?? 'legacy/network' } : undefined,
  });
  addEnvironmentStacks(app);
  if (process.env.CDKM_ENABLE_REFACTOR_STACK) {
    new RefactorStack(app, 'm02-refactor', { tier: 'dev', adoptBucketName: process.env.CDKM_ADOPT_BUCKET ?? 'cdkm-state-dev-adopted' });
  }
}
