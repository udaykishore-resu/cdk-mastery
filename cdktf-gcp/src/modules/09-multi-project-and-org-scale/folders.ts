import { Construct } from 'constructs';
import { Folder } from '@cdktf/provider-google/lib/folder';
import { FolderIamMember } from '@cdktf/provider-google/lib/folder-iam-member';
import { OrgPolicyPolicy } from '@cdktf/provider-google/lib/org-policy-policy';
import { ENVIRONMENTS, EnvironmentName } from '@cdk-mastery/shared';
import { pascal } from './project-factory';

export interface LandingZoneFoldersProps {
  /** `organizations/<num>` or `folders/<num>` — where the tree hangs. */
  readonly parent: string;
  /** Display name of the top folder, e.g. `platform`. */
  readonly name: string;
  /** Identity domain for the default groups (`gcp-<env>-viewers@<domain>`, ...). */
  readonly identityDomain: string;
  /** Environments to create child folders for. Defaults to all of ENVIRONMENTS. */
  readonly environments?: EnvironmentName[];
}

/** What a developer can do in a non-prod project without the pipeline. */
export const DEVELOPER_ROLES = ['roles/run.developer', 'roles/cloudfunctions.developer', 'roles/pubsub.editor', 'roles/cloudsql.client', 'roles/logging.viewer', 'roles/iam.serviceAccountUser'];

/**
 * Resource hierarchy:
 *
 *   organizations/<org>
 *   └── folders/<platform>                 <- org policies for every workload
 *       ├── folders/<dev>                  <- group IAM: broad
 *       ├── folders/<staging>
 *       └── folders/<prod>                 <- group IAM: narrow; extra org policies
 *
 * Folders exist for two reasons only: IAM inheritance and org-policy
 * inheritance. Anything granted or constrained on `prod` applies to every
 * project under it, present and future — which is what makes a folder-level
 * policy worth more than a per-project one that the next project may forget.
 */
export class LandingZoneFolders extends Construct {
  readonly root: Folder;
  readonly byEnvironment: Record<string, Folder> = {};

  constructor(scope: Construct, id: string, props: LandingZoneFoldersProps) {
    super(scope, id);
    this.root = new Folder(this, 'Root', { displayName: props.name, parent: props.parent, deletionProtection: true });

    // Policies that apply to every workload, at the top of the tree.
    // `spec.reset` semantics: a child folder/project can override a *list*
    // constraint (with inherit_from_parent) but a boolean `enforce` at a
    // higher level wins unless the child explicitly resets it — and resetting
    // requires orgpolicy.policy.set on the child, which workload teams do not get.
    for (const constraint of ['iam.disableServiceAccountKeyCreation', 'storage.uniformBucketLevelAccess', 'storage.publicAccessPrevention', 'compute.skipDefaultNetworkCreation']) {
      new OrgPolicyPolicy(this, `Policy${pascal(constraint)}`, {
        name: `${this.root.name}/policies/${constraint}`,
        parent: this.root.name,
        spec: { rules: [{ enforce: 'TRUE' }] },
      });
    }
    // List constraint with values: only these domains may be granted IAM.
    new OrgPolicyPolicy(this, 'PolicyAllowedDomains', {
      name: `${this.root.name}/policies/iam.allowedPolicyMemberDomains`,
      parent: this.root.name,
      // The value is the Cloud Identity customer id (`C0xxxxxxx`), not the DNS
      // domain; looked up with `gcloud organizations list --format='value(owner.directoryCustomerId)'`.
      spec: { rules: [{ values: { allowedValues: [process.env.CDKM_CUSTOMER_ID ?? 'C0123456789'] } }] },
    });

    for (const env of props.environments ?? (Object.keys(ENVIRONMENTS) as EnvironmentName[])) {
      const tier = ENVIRONMENTS[env];
      const folder = new Folder(this, `Env${pascal(env)}`, {
        displayName: env,
        parent: this.root.name,
        deletionProtection: tier.retainStatefulResources,
      });
      this.byEnvironment[env] = folder;

      // Group-based access, inherited by every project below. Never users.
      const grants: Array<[string, string]> = [
        ['roles/viewer', `gcp-${env}-viewers@${props.identityDomain}`],
        ['roles/logging.viewer', `gcp-${env}-viewers@${props.identityDomain}`],
        ['roles/monitoring.viewer', `gcp-${env}-viewers@${props.identityDomain}`],
      ];
      if (!tier.requiresApproval) {
        // Developers may change non-prod workloads directly; prod changes go
        // through the pipeline only. Curated roles, never roles/editor: the
        // module 06 conftest rule bans primitive roles and so does this folder.
        for (const role of DEVELOPER_ROLES) grants.push([role, `gcp-${env}-developers@${props.identityDomain}`]);
      } else {
        grants.push(['roles/iam.securityReviewer', `gcp-security@${props.identityDomain}`]);
        // No external IPs in prod, even if a dev project needs one for a spike.
        new OrgPolicyPolicy(this, `Env${pascal(env)}NoExternalIp`, {
          name: `${folder.name}/policies/compute.vmExternalIpAccess`,
          parent: folder.name,
          spec: { rules: [{ denyAll: 'TRUE' }] },
        });
      }
      grants.forEach(([role, group]) => {
        new FolderIamMember(this, `Env${pascal(env)}${pascal(role)}${pascal(group.split('@')[0])}`, {
          folder: folder.name,
          role,
          member: `group:${group}`,
        });
      });
    }
  }
}
