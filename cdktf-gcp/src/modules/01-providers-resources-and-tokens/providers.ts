import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { GoogleBetaProvider } from '@cdktf/provider-google-beta/lib/provider';
import { gcpProject, gcpRegion } from './gcp-config';

export interface GcpProvidersProps {
  readonly project?: string;
  readonly region?: string;
  /** Default zone for zonal resources that do not set one (e.g. `google_compute_instance`). */
  readonly zone?: string;
  /**
   * Deployer service account to impersonate. The caller only needs
   * `roles/iam.serviceAccountTokenCreator` on it; every API call is made as the
   * SA and audit logs record both identities.
   */
  readonly impersonateServiceAccount?: string;
  /**
   * Labels the provider merges into every resource that has a `labels`
   * attribute (google provider ≥ 5.0). Resource-level labels win on conflict.
   */
  readonly defaultLabels?: Record<string, string>;
}

export interface GcpProviders {
  readonly google: GoogleProvider;
  readonly beta: GoogleBetaProvider;
}

/**
 * One place for provider configuration so every stack in the module agrees.
 *
 * Providers are stack-scoped: a `TerraformStack` is a Terraform root module and
 * root modules own their `provider` blocks. Calling this in each stack is not
 * duplication, it is the model.
 */
export function configureProviders(scope: Construct, props: GcpProvidersProps = {}): GcpProviders {
  const project = props.project ?? gcpProject();
  const region = props.region ?? gcpRegion();
  const zone = props.zone ?? `${region}-a`;

  const google = new GoogleProvider(scope, 'Google', {
    project,
    region,
    zone,
    impersonateServiceAccount: props.impersonateServiceAccount,
    // Requester-pays buckets and some org-level APIs need a project to bill.
    // `userProjectOverride` sends the X-Goog-User-Project header; `billingProject`
    // says which project that is (defaults to `project`).
    userProjectOverride: true,
    billingProject: project,
    // Free-text tag that shows up in Cloud Audit Logs as `requestMetadata.requestAttributes.reason`.
    requestReason: 'cdk-mastery',
  });
  applyDefaultLabels(google, props.defaultLabels);

  // The same schema, one release ahead. Resources that exist only in google-beta
  // (or attributes that do) must be created with `provider: beta`. Alias name
  // becomes `google-beta.beta` in the JSON.
  const beta = new GoogleBetaProvider(scope, 'GoogleBeta', {
    alias: 'beta',
    project,
    region,
    zone,
    impersonateServiceAccount: props.impersonateServiceAccount,
    userProjectOverride: true,
    billingProject: project,
  });
  applyDefaultLabels(beta, props.defaultLabels);

  return { google, beta };
}

/**
 * cdktf 0.21 serialises *provider* configuration through `keysToSnakeCase`,
 * which recurses into map values: a label key `cost-center` becomes
 * `cost_center` (only `tags` and `environment` are exempt, an AWS-ism —
 * `node_modules/cdktf/lib/util.js`). Resource attributes are not affected.
 * `addOverride` is merged *after* the snake-casing, so it is the way to get the
 * keys through untouched. This is the first legitimate use of the escape hatch.
 */
function applyDefaultLabels(provider: GoogleProvider | GoogleBetaProvider, labels?: Record<string, string>): void {
  if (labels && Object.keys(labels).length > 0) {
    provider.addOverride('default_labels', labels);
  }
}
