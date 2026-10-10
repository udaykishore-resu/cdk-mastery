/**
 * Where does the provider get its project and region?
 *
 * Deliberately *not* from `gcloud config` and not from the provider's own
 * environment-variable fallbacks (`GOOGLE_PROJECT`, `GOOGLE_REGION`), because
 * those are resolved by the Terraform binary at plan time, i.e. *after* synth.
 * Anything that is decided after synth is invisible to the tests and to code
 * review. Reading it in TypeScript at synth time makes the value part of the
 * artefact (`cdk.tf.json`), which is where you want it when you diff a PR.
 */
export function gcpProject(): string {
  return process.env.CDKM_GCP_PROJECT ?? 'cdk-mastery-demo';
}

export function gcpRegion(): string {
  return process.env.CDKM_GCP_REGION ?? 'us-central1';
}
