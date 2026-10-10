/**
 * Project-level roles for the CDKTF deployer service account.
 *
 * The honest answer to "what roles does a Terraform deployer need" is "admin on
 * every service it manages", because Terraform creates, updates and deletes.
 * Least privilege here means *scoping*, not *reading*:
 *   - one deployer per environment/project (blast radius = one project);
 *   - no `roles/owner` / `roles/editor` (the conftest rule in module 06 bans them);
 *   - `roles/resourcemanager.projectIamAdmin` is the dangerous one: it lets the
 *     deployer grant itself anything. Keep it, because the capstone manages IAM,
 *     but pair it with the org policy `iam.disableServiceAccountKeyCreation`
 *     and alerting on `SetIamPolicy` by this principal;
 *   - the *plan-only* identity (exercise 2) gets viewer roles and nothing else.
 *
 * Kept as data so tests can assert the exact set and reviewers can diff it.
 */
export const DEPLOYER_PROJECT_ROLES: readonly string[] = [
  'roles/serviceusage.serviceUsageAdmin', // enable APIs (google_project_service)
  'roles/iam.serviceAccountAdmin', // create workload SAs
  'roles/iam.serviceAccountUser', // attach SAs to Cloud Run / Functions
  'roles/resourcemanager.projectIamAdmin', // google_project_iam_member
  'roles/compute.networkAdmin', // VPC, subnets, NAT, PSA ranges
  'roles/run.admin',
  'roles/cloudfunctions.admin',
  'roles/cloudscheduler.admin',
  'roles/pubsub.admin',
  'roles/cloudsql.admin',
  'roles/secretmanager.admin',
  'roles/bigquery.admin',
  'roles/monitoring.admin',
  'roles/cloudkms.admin',
  'roles/storage.admin', // buckets managed by the stacks (state bucket access is granted separately, bucket-scoped)
];

/** Read-only counterpart for `cdktf diff` on pull requests. */
export const PLANNER_PROJECT_ROLES: readonly string[] = [
  'roles/viewer',
  'roles/iam.securityReviewer', // read IAM policies (viewer alone cannot see all bindings)
  'roles/secretmanager.viewer', // metadata only; not secretAccessor
];
