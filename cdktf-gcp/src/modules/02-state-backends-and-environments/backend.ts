import { CloudBackend, GcsBackend, HttpBackend, NamedCloudWorkspace, TerraformBackend, TerraformStack } from 'cdktf';

/**
 * State backend selection, kept *conditional* so `cdktf synth` and the tests
 * work offline with the default local backend.
 *
 *   CDKM_STATE_BUCKET=my-tf-state npx cdktf synth   -> terraform.backend.gcs
 *   npx cdktf synth                                 -> terraform.backend.local (default)
 *
 * One bucket, one prefix per stack. GCS is the right default on GCP:
 *   - locking is native: the backend writes a `<prefix>/default.tflock` object
 *     with a precondition (`ifGenerationMatch: 0`), so two applies cannot
 *     overlap. No LockTable equivalent is needed.
 *   - object versioning on the bucket is the safety net: every state write is a
 *     new generation, and a corrupted or wrongly-pushed state is a
 *     `gsutil cp gs://bucket/prefix/default.tfstate#<generation>` away.
 *   - encryption is on by default (Google-managed); `kmsEncryptionKey` switches
 *     to CMEK when policy requires it.
 */
export interface StateBackendOptions {
  /** Overrides `CDKM_STATE_BUCKET`. */
  readonly bucket?: string;
  /** Optional CMEK key for the state objects (`projects/…/cryptoKeys/…`). */
  readonly kmsEncryptionKey?: string;
  /** Deployer SA to impersonate for state access; independent from the provider's. */
  readonly impersonateServiceAccount?: string;
}

export function configureBackend(stack: TerraformStack, prefix: string, options: StateBackendOptions = {}): GcsBackend | undefined {
  const bucket = options.bucket ?? process.env.CDKM_STATE_BUCKET;
  if (!bucket) return undefined;
  return new GcsBackend(stack, {
    bucket,
    prefix,
    kmsEncryptionKey: options.kmsEncryptionKey,
    impersonateServiceAccount: options.impersonateServiceAccount,
  });
}

/**
 * HCP Terraform / Terraform Enterprise. State, locking, run history and
 * policy live in the workspace; the `cloud` block replaces `backend`.
 * `cdktf login` stores the token; in CI use `TF_TOKEN_app_terraform_io`.
 * Module 08 uses this with Workload Identity Federation for the provider.
 */
export function useCloudBackend(stack: TerraformStack, organization: string, workspace: string, hostname?: string): TerraformBackend {
  return new CloudBackend(stack, {
    organization,
    workspaces: new NamedCloudWorkspace(workspace),
    hostname,
  });
}

/**
 * The generic HTTP backend: GET/POST/DELETE against a service you run (GitLab's
 * managed Terraform state is the common one). Locking is optional — only if
 * `lockAddress`/`unlockAddress` are set. Credentials come from
 * `TF_HTTP_USERNAME`/`TF_HTTP_PASSWORD` in CI rather than from the config.
 */
export function useHttpBackend(stack: TerraformStack, address: string): TerraformBackend {
  return new HttpBackend(stack, {
    address,
    lockAddress: `${address}/lock`,
    lockMethod: 'POST',
    unlockAddress: `${address}/lock`,
    unlockMethod: 'DELETE',
    retryMax: 3,
  });
}
