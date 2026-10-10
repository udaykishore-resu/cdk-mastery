import { TerraformOutput } from 'cdktf';
import { Construct } from 'constructs';
import { DataGoogleProject } from '@cdktf/provider-google/lib/data-google-project';
import { IamWorkloadIdentityPool } from '@cdktf/provider-google/lib/iam-workload-identity-pool';
import { IamWorkloadIdentityPoolProvider } from '@cdktf/provider-google/lib/iam-workload-identity-pool-provider';
import { KmsCryptoKey } from '@cdktf/provider-google/lib/kms-crypto-key';
import { KmsCryptoKeyIamMember } from '@cdktf/provider-google/lib/kms-crypto-key-iam-member';
import { KmsKeyRing } from '@cdktf/provider-google/lib/kms-key-ring';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { ProjectService } from '@cdktf/provider-google/lib/project-service';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { ServiceAccountIamMember } from '@cdktf/provider-google/lib/service-account-iam-member';
import { DEPLOYER_PROJECT_ROLES } from '../../08-cicd-and-workload-identity/deployer-roles';
import { GITHUB_ATTRIBUTE_MAPPING, GITHUB_OIDC_ISSUER, githubAttributeCondition, roleToId } from '../../08-cicd-and-workload-identity/wif-stack';
import { PlatformContext, PlatformStack } from '../platform-stack';

export const PLATFORM_APIS = [
  'serviceusage.googleapis.com',
  'cloudresourcemanager.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'sts.googleapis.com',
  'compute.googleapis.com',
  'servicenetworking.googleapis.com',
  'sqladmin.googleapis.com',
  'secretmanager.googleapis.com',
  'cloudkms.googleapis.com',
  'pubsub.googleapis.com',
  'run.googleapis.com',
  'cloudfunctions.googleapis.com',
  'cloudbuild.googleapis.com',
  'artifactregistry.googleapis.com',
  'eventarc.googleapis.com',
  'cloudscheduler.googleapis.com',
  'bigquery.googleapis.com',
  'monitoring.googleapis.com',
  'logging.googleapis.com',
  'billingbudgets.googleapis.com',
];

export interface FoundationStackProps {
  readonly ctx: PlatformContext;
  readonly github: { readonly owner: string; readonly repo: string };
}

/**
 * `m11-<env>-foundation`: what every other stack assumes exists.
 *   - APIs (ordered, never disabled on destroy)
 *   - Workload Identity Federation + the deployer SA the pipeline runs as
 *   - the CMEK key ring/key (used by data + compute in prod; harmless in dev)
 *     and the grants the Cloud SQL and GCS service agents need on it
 */
export class FoundationStack extends PlatformStack {
  readonly services: ProjectService[] = [];
  readonly deployer: ServiceAccount;
  readonly pool: IamWorkloadIdentityPool;
  readonly wifProvider: IamWorkloadIdentityPoolProvider;
  readonly key: KmsCryptoKey;
  readonly projectNumber: string;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props.ctx);
    const { project, region, tier } = this.ctx;
    const current = new DataGoogleProject(this, 'Current', { projectId: project });
    this.projectNumber = current.number;

    // -- APIs: serviceusage + resourcemanager first, then everything else -----
    let gate: ProjectService | undefined;
    for (const api of PLATFORM_APIS) {
      const svc = new ProjectService(this, `Api${pascal(api)}`, {
        project,
        service: api,
        disableOnDestroy: false,
        dependsOn: gate ? [gate] : undefined,
      });
      this.services.push(svc);
      if (api === 'serviceusage.googleapis.com' || api === 'cloudresourcemanager.googleapis.com') gate = svc;
    }

    // -- WIF for the deployer ---------------------------------------------------
    const repository = `${props.github.owner}/${props.github.repo}`;
    this.pool = new IamWorkloadIdentityPool(this, 'Pool', {
      workloadIdentityPoolId: `github-${tier.name}`,
      displayName: `GitHub Actions (${tier.name})`,
      dependsOn: this.services,
    });
    this.wifProvider = new IamWorkloadIdentityPoolProvider(this, 'GithubProvider', {
      workloadIdentityPoolId: this.pool.workloadIdentityPoolId,
      workloadIdentityPoolProviderId: 'github-actions',
      oidc: { issuerUri: GITHUB_OIDC_ISSUER },
      attributeMapping: { ...GITHUB_ATTRIBUTE_MAPPING, 'attribute.environment': 'assertion.environment' },
      attributeCondition: githubAttributeCondition({ repository }),
    });
    this.deployer = new ServiceAccount(this, 'Deployer', {
      accountId: this.name('deployer').slice(0, 30),
      displayName: `Orders deployer (${tier.name})`,
      dependsOn: this.services,
    });
    // prod: only jobs running in the protected GitHub environment "prod" may
    // become the prod deployer (required reviewers = tier.requiresApproval).
    // dev: any job from the repository.
    const principal = tier.requiresApproval
      ? `principalSet://iam.googleapis.com/${this.pool.name}/attribute.environment/${tier.name}`
      : `principalSet://iam.googleapis.com/${this.pool.name}/attribute.repository/${repository}`;
    new ServiceAccountIamMember(this, 'DeployerWorkloadIdentityUser', {
      serviceAccountId: this.deployer.name,
      role: 'roles/iam.workloadIdentityUser',
      member: principal,
    });
    for (const role of DEPLOYER_PROJECT_ROLES) {
      new ProjectIamMember(this, `DeployerRole${roleToId(role)}`, { project, role, member: this.deployer.member });
    }

    // -- CMEK ----------------------------------------------------------------------
    const ring = new KmsKeyRing(this, 'Ring', { name: this.name('ring'), location: region, dependsOn: this.services });
    this.key = new KmsCryptoKey(this, 'DataKey', {
      name: this.name('data-key'),
      keyRing: ring.id,
      rotationPeriod: '7776000s',
      labels: this.labels,
      lifecycle: { preventDestroy: tier.retainStatefulResources },
    });
    // Service agents that will encrypt with this key. Emails derive from the
    // project number; the agents are created on first API use, which the API
    // enablement above triggers for SQL/GCS (module 09 shows the explicit way).
    const agents: Record<string, string> = {
      CloudSql: `serviceAccount:service-${this.projectNumber}@gcp-sa-cloud-sql.iam.gserviceaccount.com`,
      Storage: `serviceAccount:service-${this.projectNumber}@gs-project-accounts.iam.gserviceaccount.com`,
      Bigquery: `serviceAccount:bq-${this.projectNumber}@bigquery-encryption.iam.gserviceaccount.com`,
    };
    for (const [who, member] of Object.entries(agents)) {
      new KmsCryptoKeyIamMember(this, `KeyUser${who}`, {
        cryptoKeyId: this.key.id,
        role: 'roles/cloudkms.cryptoKeyEncrypterDecrypter',
        member,
      });
    }

    new TerraformOutput(this, 'WorkloadIdentityProvider', { value: this.wifProvider.name });
    new TerraformOutput(this, 'DeployerServiceAccount', { value: this.deployer.email });
    new TerraformOutput(this, 'DataKeyId', { value: this.key.id });
  }
}

function pascal(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}
