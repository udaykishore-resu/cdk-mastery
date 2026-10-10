import { TerraformOutput, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { IamWorkloadIdentityPool } from '@cdktf/provider-google/lib/iam-workload-identity-pool';
import { IamWorkloadIdentityPoolProvider } from '@cdktf/provider-google/lib/iam-workload-identity-pool-provider';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { ServiceAccountIamMember } from '@cdktf/provider-google/lib/service-account-iam-member';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { StorageBucketIamMember } from '@cdktf/provider-google/lib/storage-bucket-iam-member';
import { gcpProject, gcpRegion } from './gcp-config';
import { DEPLOYER_PROJECT_ROLES } from './deployer-roles';

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

/**
 * Claims in a GitHub Actions OIDC token, mapped to WIF attributes. Only mapped
 * attributes can be used in `attributeCondition` or in `principalSet://` members.
 * `google.subject` is mandatory and must be ≤ 127 chars: `assertion.sub` is
 * `repo:owner/name:ref:refs/heads/main` (or `:environment:prod`), which fits.
 */
export const GITHUB_ATTRIBUTE_MAPPING: Record<string, string> = {
  'google.subject': 'assertion.sub',
  'attribute.repository': 'assertion.repository',
  'attribute.repository_owner': 'assertion.repository_owner',
  'attribute.ref': 'assertion.ref',
  'attribute.actor': 'assertion.actor',
};

export interface WifStackProps {
  /** GitHub owner (org or user) allowed to assume the deployer. */
  readonly githubOwner: string;
  /** GitHub repository name (without owner). */
  readonly githubRepo: string;
  /** Pool id: 4–32 chars, `[a-z0-9-]`, unique per project, cannot be reused for 30 days after deletion. */
  readonly poolId?: string;
  readonly providerId?: string;
  /** Deployer service account id (≤ 30 chars). */
  readonly deployerAccountId?: string;
  /** Roles granted to the deployer on the project. Defaults to DEPLOYER_PROJECT_ROLES. */
  readonly projectRoles?: readonly string[];
  /**
   * GCS bucket for Terraform state. When `create` is true the stack creates it
   * (versioned, uniform access, public access prevention); otherwise it only
   * grants the deployer object-admin on it.
   */
  readonly stateBucket?: { readonly name: string; readonly create?: boolean };
  readonly project?: string;
  readonly region?: string;
}

/**
 * Workload Identity Federation for GitHub Actions: the pool, one OIDC provider
 * restricted to one repository, a deployer service account, the binding that
 * lets tokens from that repository impersonate it, the project roles it needs,
 * and the two outputs the workflow file consumes.
 *
 * No `google_service_account_key` anywhere: the workflow exchanges GitHub's
 * short-lived OIDC token for a short-lived Google access token via the STS API.
 * Nothing to rotate, nothing to leak, and every token is attributable to a
 * repository + ref + actor in Cloud Audit Logs.
 */
export class WifStack extends TerraformStack {
  readonly pool: IamWorkloadIdentityPool;
  readonly provider: IamWorkloadIdentityPoolProvider;
  readonly deployer: ServiceAccount;
  readonly stateBucket?: StorageBucket;
  /** `principalSet://...` member for the repository. */
  readonly repositoryPrincipalSet: string;

  constructor(scope: Construct, id: string, props: WifStackProps) {
    super(scope, id);
    const project = props.project ?? gcpProject();
    new GoogleProvider(this, 'Google', { project, region: props.region ?? gcpRegion() });
    const repository = `${props.githubOwner}/${props.githubRepo}`;

    this.pool = new IamWorkloadIdentityPool(this, 'Pool', {
      workloadIdentityPoolId: props.poolId ?? 'github',
      displayName: 'GitHub Actions',
      description: `OIDC federation for ${repository}`,
    });

    this.provider = new IamWorkloadIdentityPoolProvider(this, 'GithubProvider', {
      workloadIdentityPoolId: this.pool.workloadIdentityPoolId,
      workloadIdentityPoolProviderId: props.providerId ?? 'github-actions',
      displayName: 'GitHub Actions OIDC',
      oidc: { issuerUri: GITHUB_OIDC_ISSUER },
      attributeMapping: GITHUB_ATTRIBUTE_MAPPING,
      // Without a condition, *any* GitHub repository on github.com can obtain
      // a federated identity in this pool (though not impersonate the SA until
      // a binding names it). Google now rejects GitHub providers without one.
      // The condition is CEL over the mapped attributes; `assertion.*` also works.
      attributeCondition: githubAttributeCondition({ repository }),
    });

    this.deployer = new ServiceAccount(this, 'Deployer', {
      accountId: props.deployerAccountId ?? 'cdktf-deployer',
      displayName: `CDKTF deployer for ${repository}`,
      description: 'Assumed by GitHub Actions via Workload Identity Federation; no keys.',
    });

    // The binding that makes federation useful: identities in the pool whose
    // `attribute.repository` equals ours may impersonate the deployer.
    // `pool.name` is `projects/<number>/locations/global/workloadIdentityPools/<id>`;
    // using the attribute keeps the project *number* out of our code.
    this.repositoryPrincipalSet = `principalSet://iam.googleapis.com/${this.pool.name}/attribute.repository/${repository}`;
    new ServiceAccountIamMember(this, 'DeployerWorkloadIdentityUser', {
      serviceAccountId: this.deployer.name,
      role: 'roles/iam.workloadIdentityUser',
      member: this.repositoryPrincipalSet,
    });

    for (const role of props.projectRoles ?? DEPLOYER_PROJECT_ROLES) {
      new ProjectIamMember(this, `DeployerRole${roleToId(role)}`, {
        project,
        role,
        member: this.deployer.member,
      });
    }

    if (props.stateBucket) {
      if (props.stateBucket.create) {
        this.stateBucket = new StorageBucket(this, 'StateBucket', {
          name: props.stateBucket.name,
          location: (props.region ?? gcpRegion()).toUpperCase(),
          uniformBucketLevelAccess: true,
          publicAccessPrevention: 'enforced',
          versioning: { enabled: true }, // state history is your undo button
          lifecycleRule: [{ condition: { numNewerVersions: 20 }, action: { type: 'Delete' } }],
          // The state bucket outlives every stack that uses it; never let a
          // destroy of this stack take it along.
          lifecycle: { preventDestroy: true },
        });
      }
      new StorageBucketIamMember(this, 'DeployerStateAccess', {
        bucket: this.stateBucket ? this.stateBucket.name : props.stateBucket.name,
        role: 'roles/storage.objectAdmin',
        member: this.deployer.member,
      });
    }

    // Exactly what `google-github-actions/auth@v2` needs.
    new TerraformOutput(this, 'workload_identity_provider', {
      value: this.provider.name,
      description: 'projects/<num>/locations/global/workloadIdentityPools/<pool>/providers/<provider>',
    });
    new TerraformOutput(this, 'service_account', { value: this.deployer.email });
    if (props.stateBucket) {
      new TerraformOutput(this, 'state_bucket', { value: props.stateBucket.name });
    }
  }
}

export interface GithubConditionProps {
  /** `owner/repo` */
  readonly repository: string;
  /** Restrict further to refs, e.g. `refs/heads/main`. */
  readonly refs?: string[];
}

/**
 * The CEL attribute condition. Pitfalls this encodes:
 *   - compare `attribute.repository` (mapped) — comparing `assertion.repository`
 *     also works, but only mapped attributes can appear in principalSet members,
 *     so keep one vocabulary;
 *   - repository names are case-sensitive in the claim; use the canonical casing;
 *   - `attribute.ref` is `refs/heads/main`, not `main`; for `environment`
 *     deployments the ref is the *deployment* ref and `sub` carries `environment:`.
 */
export function githubAttributeCondition(props: GithubConditionProps): string {
  const parts = [`attribute.repository == "${props.repository}"`];
  if (props.refs && props.refs.length > 0) {
    parts.push(`attribute.ref in [${props.refs.map((r) => `"${r}"`).join(', ')}]`);
  }
  return parts.join(' && ');
}

/** `roles/run.admin` -> `RunAdmin` — PascalCase, so the ids satisfy the house naming rule. */
export function roleToId(role: string): string {
  return role
    .replace(/^roles\//, '')
    .split(/[.\-_/]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}
