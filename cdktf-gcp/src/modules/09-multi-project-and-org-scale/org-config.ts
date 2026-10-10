/**
 * Org-level identifiers. Numeric org ids and billing-account ids are not
 * secrets but they are environment-specific, so they come from the environment
 * with demo defaults that let everything synthesize offline.
 */
export function gcpProject(): string {
  return process.env.CDKM_GCP_PROJECT ?? 'cdk-mastery-demo';
}

export function gcpRegion(): string {
  return process.env.CDKM_GCP_REGION ?? 'us-central1';
}

/** Numeric organization id (`gcloud organizations list`). */
export function orgId(): string {
  return process.env.CDKM_ORG_ID ?? '123456789012';
}

/** `XXXXXX-XXXXXX-XXXXXX` (`gcloud billing accounts list`). */
export function billingAccount(): string {
  return process.env.CDKM_BILLING_ACCOUNT ?? '000000-AAAAAA-BBBBBB';
}

/** Google Workspace / Cloud Identity domain used for `group:` principals. */
export function identityDomain(): string {
  return process.env.CDKM_IDENTITY_DOMAIN ?? 'example.com';
}
