import * as cdk from 'aws-cdk-lib';
import * as cxapi from 'aws-cdk-lib/cx-api';
import { IConstruct } from 'constructs';

/**
 * Feature flags are *context*: `cdk.json` → `CDK_CONTEXT_JSON` env var → `App`
 * → `FeatureFlags.of(scope).isEnabled(flag)`. Nothing else. Consequences:
 *
 *  - A bare `new cdk.App()` in a test has **no** flags set; it renders with the
 *    v2 unconfigured defaults, not with your `cdk.json`. Pass `context` when a
 *    test depends on a flag (module 06/09 tests do).
 *  - Upgrading `aws-cdk-lib` is safe *because* flags are opt-in: a new flag's
 *    unconfigured value is the old behaviour. `cdk init` writes every recommended
 *    flag into `cdk.json`; an app started on 2.100 and upgraded to 2.269 keeps its
 *    2.100 behaviour until you add the new flags — deliberately, one at a time,
 *    reading the diff. That is what "pinning" means here: the set in `cdk.json`
 *    is the pin; `package.json` pins the library.
 *  - `cdk flags` (CLI ≥ 2.1000) lists every flag with its recommended value and
 *    whether your context sets it; `cdk flags --all --recommended` and
 *    `cdk flags <name> --set --value true` edit `cdk.json` for you.
 *
 * `missingRecommendedFlags` is the in-process version of `cdk flags`: it
 * compares the library's `CURRENTLY_RECOMMENDED_FLAGS` with what the App's
 * context sets. Run it in a unit test against your real `cdk.json` to catch
 * drift after every library upgrade.
 */
export interface FlagStatus {
  readonly flag: string;
  readonly recommended: unknown;
  readonly configured: unknown;
  readonly summary: string;
}

export function missingRecommendedFlags(scope: IConstruct): FlagStatus[] {
  const out: FlagStatus[] = [];
  for (const [flag, recommended] of Object.entries(cxapi.CURRENTLY_RECOMMENDED_FLAGS)) {
    const configured = scope.node.tryGetContext(flag);
    if (configured === undefined) {
      out.push({ flag, recommended, configured, summary: cxapi.FLAGS[flag]?.summary ?? '' });
    }
  }
  return out.sort((a, b) => a.flag.localeCompare(b.flag));
}

/** The flags this module's behaviour depends on, for the README and the tests. */
export const FLAGS_WE_DEPEND_ON = [
  cxapi.DEFAULT_CROSS_STACK_REFERENCES, // "strong" (custom resources) vs "weak" (Fn::GetStackOutput)
  cxapi.ASPECT_PRIORITIES_MUTATING,
  cxapi.ANNOTATIONS_IN_VALIDATION_REPORT,
] as const;

export function flagValue(scope: IConstruct, flag: string): unknown {
  // `FeatureFlags.isEnabled` is boolean-only and *throws* for string-valued flags
  // such as defaultCrossStackReferences ("strong" | "weak" | "both"); read raw
  // context for those and fall back to isEnabled only for boolean flags.
  const raw = scope.node.tryGetContext(flag);
  if (raw !== undefined) return raw;
  const info = cxapi.FLAGS[flag];
  return typeof info?.recommendedValue === 'boolean' ? cdk.FeatureFlags.of(scope).isEnabled(flag) : undefined;
}
