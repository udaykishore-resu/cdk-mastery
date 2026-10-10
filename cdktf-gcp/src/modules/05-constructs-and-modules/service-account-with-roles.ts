import { Annotations } from 'cdktf';
import { Construct } from 'constructs';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { ServiceAccountIamMember } from '@cdktf/provider-google/lib/service-account-iam-member';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';

export interface ServiceAccountWithRolesProps {
  readonly accountId: string;
  readonly displayName?: string;
  readonly project: string;
  /** Project-level roles, e.g. `roles/cloudsql.client`. Primitive roles are rejected. */
  readonly roles?: readonly string[];
}

const PRIMITIVE_ROLES = new Set(['roles/owner', 'roles/editor', 'roles/viewer']);

/**
 * A service account plus its project-level grants, with the two things a
 * platform team always ends up enforcing by review: no primitive roles, and
 * `roles/` prefixed, well-formed role names. Both are enforced at synth so
 * the review can look at intent instead of syntax.
 */
export class ServiceAccountWithRoles extends Construct {
  readonly account: ServiceAccount;
  /** `serviceAccount:<email>` — what IAM `member` fields want. */
  readonly member: string;
  readonly email: string;
  readonly grants: ProjectIamMember[] = [];

  constructor(scope: Construct, id: string, props: ServiceAccountWithRolesProps) {
    super(scope, id);
    const roles = props.roles ?? [];

    this.node.addValidation({
      validate: () => {
        const errors: string[] = [];
        if (!/^[a-z]([-a-z0-9]{4,28}[a-z0-9])$/.test(props.accountId)) {
          errors.push(`accountId "${props.accountId}" must match ^[a-z]([-a-z0-9]{4,28}[a-z0-9])$ (6-30 chars)`);
        }
        for (const role of roles) {
          if (!/^(roles\/[A-Za-z0-9.]+|projects\/[^/]+\/roles\/[A-Za-z0-9_.]+|organizations\/\d+\/roles\/[A-Za-z0-9_.]+)$/.test(role)) {
            errors.push(`role "${role}" is not a valid predefined or custom role name`);
          }
        }
        return errors;
      },
    });
    for (const role of roles) {
      if (PRIMITIVE_ROLES.has(role)) {
        // An error annotation aborts synth with a clear message and the construct path.
        Annotations.of(this).addError(`primitive role ${role} is not allowed; use a predefined or custom role`);
      }
    }

    this.account = new ServiceAccount(this, 'Account', { accountId: props.accountId, displayName: props.displayName ?? props.accountId });
    this.member = this.account.member;
    this.email = this.account.email;

    roles.forEach((role) => {
      // Id from the role so adding/removing a role touches exactly one resource.
      const roleId = role.replace(/^.*roles\//, '').replace(/[^A-Za-z0-9]/g, '');
      this.grants.push(new ProjectIamMember(this, `Role${roleId}`, { project: props.project, role, member: this.member }));
    });
  }

  /** Let `member` impersonate this account (short-lived tokens; the human-deploys-as-SA pattern). */
  grantImpersonation(member: string, id = 'Impersonation'): ServiceAccountIamMember {
    return new ServiceAccountIamMember(this, id, { serviceAccountId: this.account.name, role: 'roles/iam.serviceAccountTokenCreator', member });
  }

  /** Let `member` attach this account to resources (Cloud Run, GCE) — `actAs`. */
  grantActAs(member: string, id = 'ActAs'): ServiceAccountIamMember {
    return new ServiceAccountIamMember(this, id, { serviceAccountId: this.account.name, role: 'roles/iam.serviceAccountUser', member });
  }
}
