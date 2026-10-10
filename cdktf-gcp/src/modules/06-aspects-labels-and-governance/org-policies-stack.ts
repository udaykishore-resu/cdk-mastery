import { TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { OrgPolicyPolicy } from '@cdktf/provider-google/lib/org-policy-policy';
import { gcpProject, gcpRegion } from './gcp-config';

export interface OrgPoliciesStackProps {
  /**
   * Where to attach the constraints: `projects/<id>`, `folders/<num>` or
   * `organizations/<num>`. Defaults to the demo project so the stack can be
   * applied by a project owner; in a real landing zone these live at the
   * folder or org level and are owned by the security team (module 09).
   */
  readonly parent?: string;
  readonly project?: string;
  readonly region?: string;
}

/**
 * Organisation policy constraints. Unlike everything else in this module these
 * are enforced by Google's control plane, at API-call time, against *every*
 * caller: gcloud, the console, a Terraform run from someone's laptop, a script
 * with a leaked key. Aspects and conftest only ever see the code you ran them on.
 *
 * `google_org_policy_policy` is the v2 resource (Org Policy API). The name is
 * `<parent>/policies/<constraint>`; boolean constraints use `enforce`, list
 * constraints use `allowAll`/`denyAll`/`values`. Values are the strings "TRUE"
 * and "FALSE" because the API models them that way.
 */
export class OrgPoliciesStack extends TerraformStack {
  readonly policies: OrgPolicyPolicy[] = [];

  constructor(scope: Construct, id: string, props: OrgPoliciesStackProps = {}) {
    super(scope, id);
    const project = props.project ?? gcpProject();
    new GoogleProvider(this, 'Google', { project, region: props.region ?? gcpRegion() });
    const parent = props.parent ?? `projects/${project}`;

    const boolean = (constructId: string, constraint: string) =>
      new OrgPolicyPolicy(this, constructId, {
        name: `${parent}/policies/${constraint}`,
        parent,
        spec: { rules: [{ enforce: 'TRUE' }] },
      });

    // No bucket under this parent can ever be made public, whatever its own
    // `public_access_prevention` says. The bucket setting in GovernedStack and the
    // NoPublicBucketsAspect are redundant with this on purpose (defence in depth,
    // and the aspect fails at synth while this fails at apply).
    this.policies.push(boolean('PublicAccessPrevention', 'storage.publicAccessPrevention'));

    // No VM gets an external IP. Combined with Cloud NAT (module 03) this removes
    // the whole "someone opened 22/tcp to the world" class of incidents.
    this.policies.push(
      new OrgPolicyPolicy(this, 'NoExternalIps', {
        name: `${parent}/policies/compute.vmExternalIpAccess`,
        parent,
        spec: { rules: [{ denyAll: 'TRUE' }] },
      }),
    );

    // No user-managed service account keys. Module 08 replaces them with
    // Workload Identity Federation; this constraint makes the replacement permanent.
    this.policies.push(boolean('NoSaKeys', 'iam.disableServiceAccountKeyCreation'));

    // Uniform bucket-level access everywhere (no legacy ACLs). Matches the
    // conftest rule in policy/buckets.rego, again on purpose.
    this.policies.push(boolean('UniformBucketAccess', 'storage.uniformBucketLevelAccess'));
  }
}
