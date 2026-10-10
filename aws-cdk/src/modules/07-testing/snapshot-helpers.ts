import * as cdk from 'aws-cdk-lib';

/**
 * Snapshot tests fail for two reasons that have nothing to do with your change:
 *
 *  1. Asset hashes. `Code.fromAsset` renders `S3Key: "<sha256>.zip"`; touch a
 *     comment in the handler and the hash — and the snapshot — changes.
 *  2. Bootstrap plumbing. The default synthesizer adds a `BootstrapVersion`
 *     parameter and a `CheckBootstrapVersion` rule; a bootstrap bump changes them.
 *
 * Two remedies, used together in the tests:
 *
 *  - `stableSynthesizer()` — a `DefaultStackSynthesizer` with
 *    `generateBootstrapVersionRule: false`, so the template carries no bootstrap
 *    version check. Only for tests: production stacks want that rule.
 *  - `stabilizeAssets(template)` — replaces every 64-hex asset hash in `S3Key`
 *    values (and the `aws:asset:path`/`aws:asset:property` metadata) with a
 *    constant, so the snapshot pins *structure*, not content.
 *
 * Everything else in a template is deterministic for a given aws-cdk-lib version.
 */
export function stableSynthesizer(): cdk.DefaultStackSynthesizer {
  return new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false });
}

const ASSET_HASH = /^[0-9a-f]{64}(\.zip|\.json)?$/;

export function stabilizeAssets<T>(template: T): T {
  return walk(template) as T;

  function walk(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if ((k === 'S3Key' || k === 'aws:asset:path') && typeof v === 'string' && ASSET_HASH.test(v.replace(/^asset\./, ''))) {
          out[k] = v.replace(/[0-9a-f]{64}/, '<asset-hash>');
        } else {
          out[k] = walk(v);
        }
      }
      return out;
    }
    return value;
  }
}
