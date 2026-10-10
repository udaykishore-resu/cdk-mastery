import { Construct } from 'constructs';
import { ComputeSubnetwork } from '@cdktf/provider-google/lib/compute-subnetwork';
import { ComputeSubnetworkIamMember } from '@cdktf/provider-google/lib/compute-subnetwork-iam-member';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { ITerraformDependable } from 'cdktf';

/**
 * Exercise 3 (hard): Google-managed service agents that need Shared VPC access.
 *
 * When a *service project* workload wants a NIC in a *host project* subnet, it
 * is not the workload's SA that creates the NIC: it is the product's service
 * agent in the service project, whose email is derived from the service
 * project's *number*. The agents, their emails and the roles they need on the
 * host are documented per product and change rarely, but getting one wrong
 * yields a permission error naming a principal you never created.
 */
export type SharedVpcConsumer = 'cloudrun' | 'cloudfunctions' | 'gke' | 'cloudsql' | 'dataflow' | 'composer';

export interface AgentGrant {
  /** `serviceAccount:` member. */
  readonly member: string;
  /** Roles on each shared subnet. */
  readonly subnetRoles: string[];
  /** Roles on the host project itself. */
  readonly hostProjectRoles: string[];
}

/** Service-agent emails as a function of the service project number (`google_project.number`). */
export function serviceAgentGrants(projectNumber: string, consumer: SharedVpcConsumer): AgentGrant[] {
  const sa = (email: string) => `serviceAccount:${email}`;
  switch (consumer) {
    case 'cloudrun':
    case 'cloudfunctions':
      return [
        // Direct VPC egress and Serverless VPC Access connectors are created by this agent.
        { member: sa(`service-${projectNumber}@serverless-robot-prod.iam.gserviceaccount.com`), subnetRoles: ['roles/compute.networkUser'], hostProjectRoles: ['roles/vpcaccess.user'] },
      ];
    case 'gke':
      return [
        { member: sa(`service-${projectNumber}@container-engine-robot.iam.gserviceaccount.com`), subnetRoles: ['roles/compute.networkUser'], hostProjectRoles: ['roles/container.hostServiceAgentUser'] },
        { member: sa(`${projectNumber}@cloudservices.gserviceaccount.com`), subnetRoles: ['roles/compute.networkUser'], hostProjectRoles: [] },
      ];
    case 'cloudsql':
      // Private IP for Cloud SQL uses Private Service Access on the *host* VPC; the
      // agent needs to see the network, not a subnet.
      return [{ member: sa(`service-${projectNumber}@gcp-sa-cloud-sql.iam.gserviceaccount.com`), subnetRoles: [], hostProjectRoles: ['roles/compute.networkUser'] }];
    case 'dataflow':
      return [
        { member: sa(`service-${projectNumber}@dataflow-service-producer-prod.iam.gserviceaccount.com`), subnetRoles: ['roles/compute.networkUser'], hostProjectRoles: [] },
        { member: sa(`${projectNumber}-compute@developer.gserviceaccount.com`), subnetRoles: ['roles/compute.networkUser'], hostProjectRoles: [] },
      ];
    case 'composer':
      return [
        { member: sa(`service-${projectNumber}@cloudcomposer-accounts.iam.gserviceaccount.com`), subnetRoles: ['roles/compute.networkUser'], hostProjectRoles: ['roles/composer.sharedVpcAgent'] },
        { member: sa(`service-${projectNumber}@container-engine-robot.iam.gserviceaccount.com`), subnetRoles: ['roles/compute.networkUser'], hostProjectRoles: ['roles/container.hostServiceAgentUser'] },
      ];
  }
}

export interface ServiceAgentSubnetAccessProps {
  readonly hostProject: string;
  /** Service project number (token from `google_project.number` is fine). */
  readonly serviceProjectNumber: string;
  readonly consumers: SharedVpcConsumer[];
  readonly subnets: ComputeSubnetwork[];
  readonly dependsOn?: ITerraformDependable[];
}

export class ServiceAgentSubnetAccess extends Construct {
  readonly subnetGrants: ComputeSubnetworkIamMember[] = [];
  readonly hostGrants: ProjectIamMember[] = [];

  constructor(scope: Construct, id: string, props: ServiceAgentSubnetAccessProps) {
    super(scope, id);
    // De-duplicate across consumers (GKE and Composer share the container robot).
    const seen = new Set<string>();
    for (const consumer of props.consumers) {
      for (const grant of serviceAgentGrants(props.serviceProjectNumber, consumer)) {
        for (const role of grant.subnetRoles) {
          for (const subnet of props.subnets) {
            const key = `${grant.member}|${role}|${subnet.node.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            this.subnetGrants.push(
              new ComputeSubnetworkIamMember(this, `Subnet${subnet.node.id}${pascalMember(grant.member)}${pascalRole(role)}`, {
                project: props.hostProject,
                region: subnet.region,
                subnetwork: subnet.name,
                role,
                member: grant.member,
                dependsOn: props.dependsOn,
              }),
            );
          }
        }
        for (const role of grant.hostProjectRoles) {
          const key = `${grant.member}|${role}|host`;
          if (seen.has(key)) continue;
          seen.add(key);
          this.hostGrants.push(
            new ProjectIamMember(this, `Host${pascalMember(grant.member)}${pascalRole(role)}`, {
              project: props.hostProject,
              role,
              member: grant.member,
              dependsOn: props.dependsOn,
            }),
          );
        }
      }
    }
  }
}

/** Construct-id-safe fragment from an agent email: the domain's first label, e.g. `ServerlessRobotProd`. */
function pascalMember(member: string): string {
  const domain = member.split('@')[1] ?? member;
  const label = domain.split('.')[0];
  const prefix = member.includes('-compute@') ? 'ComputeDefault' : member.includes('@cloudservices.') ? 'CloudServices' : '';
  return prefix || label.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

function pascalRole(role: string): string {
  return role.replace(/^roles\//, '').split(/[.\-]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}
