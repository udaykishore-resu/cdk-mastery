/**
 * Project / region resolution for this module. Read at synth time (not by the
 * Terraform binary at plan time) so the values are part of `cdk.tf.json` and
 * therefore visible to tests, code review and the conftest policies in `policy/`.
 */
export function gcpProject(): string {
  return process.env.CDKM_GCP_PROJECT ?? 'cdk-mastery-demo';
}

export function gcpRegion(): string {
  return process.env.CDKM_GCP_REGION ?? 'us-central1';
}
