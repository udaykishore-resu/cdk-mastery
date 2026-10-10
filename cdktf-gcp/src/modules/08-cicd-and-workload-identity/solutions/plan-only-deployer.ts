import { Construct } from 'constructs';
import { IamWorkloadIdentityPool } from '@cdktf/provider-google/lib/iam-workload-identity-pool';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { ServiceAccountIamMember } from '@cdktf/provider-google/lib/service-account-iam-member';
import { StorageBucketIamMember } from '@cdktf/provider-google/lib/storage-bucket-iam-member';
import { PLANNER_PROJECT_ROLES } from '../deployer-roles';
import { roleToId } from '../wif-stack';

export interface PlanOnlyDeployerProps {
  readonly project: string;
  readonly pool: IamWorkloadIdentityPool;
  /** `owner/repo` — any branch of this repository may plan. */
  readonly repository: string;
  readonly stateBucket: string;
  readonly accountId?: string;
}

/**
 * Exercise 2 (medium): a second identity for pull requests with read-only
 * roles, so a malicious PR cannot `apply` even if the workflow is edited.
 *
 * One caveat that only shows up in practice: the GCS backend takes a lock by
 * *writing* `<prefix>/default.tflock`, so a strictly read-only principal fails
 * `terraform init`/`plan` with a 403 on the lock. Options: run the plan with
 * `-lock=false` (the drift job in the example workflow does this), or grant
 * `roles/storage.objectAdmin` scoped by IAM condition to the lock object. This
 * construct grants `objectViewer` and expects `-lock=false`.
 */
export class PlanOnlyDeployer extends Construct {
  readonly account: ServiceAccount;

  constructor(scope: Construct, id: string, props: PlanOnlyDeployerProps) {
    super(scope, id);
    this.account = new ServiceAccount(this, 'Account', {
      accountId: props.accountId ?? 'cdktf-planner',
      displayName: `CDKTF planner for ${props.repository}`,
      description: 'Read-only identity for cdktf diff on pull requests.',
    });
    new ServiceAccountIamMember(this, 'WorkloadIdentityUser', {
      serviceAccountId: this.account.name,
      role: 'roles/iam.workloadIdentityUser',
      member: `principalSet://iam.googleapis.com/${props.pool.name}/attribute.repository/${props.repository}`,
    });
    for (const role of PLANNER_PROJECT_ROLES) {
      new ProjectIamMember(this, `Role${roleToId(role)}`, { project: props.project, role, member: this.account.member });
    }
    new StorageBucketIamMember(this, 'StateRead', {
      bucket: props.stateBucket,
      role: 'roles/storage.objectViewer',
      member: this.account.member,
    });
  }
}
