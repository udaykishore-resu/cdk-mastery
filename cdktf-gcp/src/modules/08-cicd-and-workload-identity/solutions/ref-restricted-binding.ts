import { Construct } from 'constructs';
import { IamWorkloadIdentityPool } from '@cdktf/provider-google/lib/iam-workload-identity-pool';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { ServiceAccountIamMember } from '@cdktf/provider-google/lib/service-account-iam-member';

/**
 * Exercise 1 (easy): only `main` may deploy, while pull requests from any
 * branch may still obtain an identity to *plan*.
 *
 * Two knobs, two layers:
 *   - the provider's `attributeCondition` restricts which tokens get *into the
 *     pool* (repository == ours; any ref);
 *   - the service-account binding restricts which pool identities may
 *     *impersonate the deployer*: `principalSet://.../attribute.ref/refs/heads/main`.
 *
 * The planner SA (exercise 2) is bound on `attribute.repository` instead, so a
 * PR branch can plan but not deploy. `attribute.ref` must be in the provider's
 * attribute mapping or the principalSet never matches — silently.
 */
export function refPrincipalSet(pool: IamWorkloadIdentityPool, ref: string): string {
  return `principalSet://iam.googleapis.com/${pool.name}/attribute.ref/${ref}`;
}

export function bindDeployerToRef(scope: Construct, id: string, pool: IamWorkloadIdentityPool, deployer: ServiceAccount, ref = 'refs/heads/main'): ServiceAccountIamMember {
  if (!ref.startsWith('refs/')) {
    throw new Error(`ref must be fully qualified (refs/heads/main, refs/tags/v1), got "${ref}"`);
  }
  return new ServiceAccountIamMember(scope, id, {
    serviceAccountId: deployer.name,
    role: 'roles/iam.workloadIdentityUser',
    member: refPrincipalSet(pool, ref),
  });
}
