import { TerraformOutput, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { IamWorkloadIdentityPool } from '@cdktf/provider-google/lib/iam-workload-identity-pool';
import { IamWorkloadIdentityPoolProvider } from '@cdktf/provider-google/lib/iam-workload-identity-pool-provider';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { ServiceAccountIamMember } from '@cdktf/provider-google/lib/service-account-iam-member';
import { ENVIRONMENTS, EnvironmentName, EnvironmentTier } from '@cdk-mastery/shared';
import { DEPLOYER_PROJECT_ROLES } from '../deployer-roles';
import { gcpProject, gcpRegion } from '../gcp-config';
import { GITHUB_ATTRIBUTE_MAPPING, GITHUB_OIDC_ISSUER, githubAttributeCondition, roleToId } from '../wif-stack';

export interface MultiEnvWifStackProps {
  readonly githubOwner: string;
  readonly githubRepo: string;
  /** Project per environment (a landing zone has one project per env; module 09). */
  readonly projects: Record<EnvironmentName, string>;
  /** Which environments to create deployers for. Defaults to all in ENVIRONMENTS. */
  readonly environments?: EnvironmentName[];
  /** Project that hosts the pool (usually the CI/"seed" project). */
  readonly project?: string;
  readonly region?: string;
}

export interface EnvironmentDeployer {
  readonly tier: EnvironmentTier;
  readonly account: ServiceAccount;
  readonly principalSet: string;
}

/**
 * Exercise 3 (hard): one pool, one provider, one deployer *per environment*,
 * each bound to a GitHub *environment* rather than a branch.
 *
 * GitHub Actions jobs that declare `environment: prod` get a token whose `sub`
 * is `repo:owner/repo:environment:prod` and whose `environment` claim is `prod`.
 * Mapping `attribute.environment = assertion.environment` lets the SA binding
 * say "only jobs running in the prod environment may become the prod deployer".
 * GitHub's environment protection rules (required reviewers, wait timers,
 * branch restrictions) then become the approval gate, which is exactly what
 * `tier.requiresApproval` asks for — enforced by GitHub, verified by Google.
 *
 * Pitfall: a job *without* an `environment:` key has no `environment` claim, so
 * `attribute.environment` is empty and matches no binding — the token cannot
 * impersonate anything. That is the safe failure.
 */
export class MultiEnvWifStack extends TerraformStack {
  readonly pool: IamWorkloadIdentityPool;
  readonly provider: IamWorkloadIdentityPoolProvider;
  readonly deployers: Record<string, EnvironmentDeployer> = {};

  constructor(scope: Construct, id: string, props: MultiEnvWifStackProps) {
    super(scope, id);
    const project = props.project ?? gcpProject();
    new GoogleProvider(this, 'Google', { project, region: props.region ?? gcpRegion() });
    const repository = `${props.githubOwner}/${props.githubRepo}`;

    this.pool = new IamWorkloadIdentityPool(this, 'Pool', { workloadIdentityPoolId: 'github-envs', displayName: 'GitHub Actions (per environment)' });
    this.provider = new IamWorkloadIdentityPoolProvider(this, 'GithubProvider', {
      workloadIdentityPoolId: this.pool.workloadIdentityPoolId,
      workloadIdentityPoolProviderId: 'github-actions',
      oidc: { issuerUri: GITHUB_OIDC_ISSUER },
      attributeMapping: { ...GITHUB_ATTRIBUTE_MAPPING, 'attribute.environment': 'assertion.environment' },
      attributeCondition: githubAttributeCondition({ repository }),
    });

    for (const name of props.environments ?? (Object.keys(ENVIRONMENTS) as EnvironmentName[])) {
      const tier = ENVIRONMENTS[name];
      const targetProject = props.projects[name];
      const account = new ServiceAccount(this, `Deployer${capitalise(name)}`, {
        accountId: `cdktf-deployer-${name}`,
        displayName: `CDKTF deployer (${name})`,
        description: tier.requiresApproval ? 'Bound to a protected GitHub environment; deploys need reviewer approval.' : 'Bound to an unprotected GitHub environment.',
      });
      const principalSet = `principalSet://iam.googleapis.com/${this.pool.name}/attribute.environment/${name}`;
      new ServiceAccountIamMember(this, `Deployer${capitalise(name)}WorkloadIdentityUser`, {
        serviceAccountId: account.name,
        role: 'roles/iam.workloadIdentityUser',
        member: principalSet,
      });
      for (const role of DEPLOYER_PROJECT_ROLES) {
        new ProjectIamMember(this, `Deployer${capitalise(name)}Role${roleToId(role)}`, { project: targetProject, role, member: account.member });
      }
      this.deployers[name] = { tier, account, principalSet };
      new TerraformOutput(this, `service_account_${name}`, { value: account.email });
    }
    new TerraformOutput(this, 'workload_identity_provider', { value: this.provider.name });
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
