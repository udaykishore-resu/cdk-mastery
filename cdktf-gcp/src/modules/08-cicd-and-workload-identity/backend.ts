import { CloudBackend, GcsBackend, LocalBackend, NamedCloudWorkspace, TaggedCloudWorkspaces, TerraformBackend, TerraformStack } from 'cdktf';

/**
 * Where state lives is a deployment concern, not a stack concern, so it is a
 * small discriminated union the stack factory resolves from the environment.
 *
 *   gcs   — the default for this track: a versioned bucket, object-level
 *           locking via GCS generation preconditions, WIF-authenticated.
 *   cloud — HCP Terraform (formerly Terraform Cloud): remote state *and* remote
 *           runs, run history, policy sets (Sentinel/OPA), a UI. In CDKTF the
 *           `cloud` block is rendered from `CloudBackend`; the CLI logs in with
 *           `terraform login` or `TF_TOKEN_app_terraform_io`.
 *   local — offline synth and unit tests. Never for a shared environment.
 */
export type BackendConfig =
  | { readonly kind: 'gcs'; readonly bucket: string; readonly prefix: string }
  | { readonly kind: 'cloud'; readonly organization: string; readonly workspace: string | { readonly tags: string[] }; readonly hostname?: string }
  | { readonly kind: 'local' };

export function configureBackend(stack: TerraformStack, config: BackendConfig): TerraformBackend {
  switch (config.kind) {
    case 'gcs':
      return new GcsBackend(stack, { bucket: config.bucket, prefix: config.prefix });
    case 'cloud':
      return new CloudBackend(stack, {
        organization: config.organization,
        hostname: config.hostname, // undefined -> app.terraform.io
        workspaces: typeof config.workspace === 'string' ? new NamedCloudWorkspace(config.workspace) : new TaggedCloudWorkspaces(config.workspace.tags),
      });
    case 'local':
      return new LocalBackend(stack, {});
  }
}

/**
 * Resolve the backend from the environment, keeping offline synth local:
 *   CDKM_STATE_BUCKET=<bucket>        -> gcs
 *   CDKM_TFC_ORG=<org>                -> HCP Terraform, workspace = stack id
 *   neither                           -> local
 */
export function backendFromEnv(stackId: string, env: NodeJS.ProcessEnv = process.env): BackendConfig {
  if (env.CDKM_STATE_BUCKET) return { kind: 'gcs', bucket: env.CDKM_STATE_BUCKET, prefix: `cdk-mastery/${stackId}` };
  if (env.CDKM_TFC_ORG) return { kind: 'cloud', organization: env.CDKM_TFC_ORG, workspace: stackId };
  return { kind: 'local' };
}
