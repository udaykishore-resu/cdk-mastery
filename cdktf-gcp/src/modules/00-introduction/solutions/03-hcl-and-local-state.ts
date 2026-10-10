/**
 * Exercise 3 — HCL output and an explicit local backend.
 *
 * Two things the README claims that you should be able to prove:
 *   1. `cdktf synth --hcl` is nothing more than `stack.toHclTerraform()` written
 *      to `cdk.tf` instead of `cdk.tf.json` — same tree, same tokens, different
 *      serializer. HCL-only teams can review that file without learning JSON.
 *   2. With no backend configured, state is a *local* file whose path is
 *      absolute and derived from `process.cwd()` at synth time. An explicit
 *      `LocalBackend` with a relative `path` moves it somewhere deliberate.
 */
import { LocalBackend, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { HelloStack, HelloStackProps } from '../hello-stack';

export interface LocalStateHelloStackProps extends HelloStackProps {
  /** Directory (relative to the stack's working directory) where terraform.tfstate lands. */
  readonly stateDir: string;
}

export class LocalStateHelloStack extends HelloStack {
  constructor(scope: Construct, id: string, props: LocalStateHelloStackProps) {
    super(scope, id, props);
    // A backend is a stack-scoped singleton: the construct id is fixed to
    // "backend" by the base class and a second one throws at synth.
    new LocalBackend(this, { path: `${props.stateDir}/${id}.tfstate` });
  }
}

export interface HclRendering {
  readonly hcl: string;
  /** Resource addresses found in the HCL text, e.g. `google_storage_bucket.Artifacts`. */
  readonly addresses: readonly string[];
}

/** Render a stack as HCL the same way `SYNTH_HCL_OUTPUT=true` / `cdktf synth --hcl` does. */
export function renderHcl(stack: TerraformStack): HclRendering {
  const { hcl } = stack.toHclTerraform() as { hcl: string };
  const addresses = [...hcl.matchAll(/^resource "([^"]+)" "([^"]+)"/gm)].map((m) => `${m[1]}.${m[2]}`);
  return { hcl, addresses };
}
