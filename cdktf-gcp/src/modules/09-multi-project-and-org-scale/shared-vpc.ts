import { Construct } from 'constructs';
import { ComputeNetwork } from '@cdktf/provider-google/lib/compute-network';
import { ComputeRouter } from '@cdktf/provider-google/lib/compute-router';
import { ComputeRouterNat } from '@cdktf/provider-google/lib/compute-router-nat';
import { ComputeSharedVpcHostProject } from '@cdktf/provider-google/lib/compute-shared-vpc-host-project';
import { ComputeSharedVpcServiceProject } from '@cdktf/provider-google/lib/compute-shared-vpc-service-project';
import { ComputeSubnetwork } from '@cdktf/provider-google/lib/compute-subnetwork';
import { ComputeSubnetworkIamMember } from '@cdktf/provider-google/lib/compute-subnetwork-iam-member';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { ITerraformDependable } from 'cdktf';
import { regionShortCode } from '@cdk-mastery/shared';
import { RegionalProviders } from './regional-providers';

export interface RegionalSubnetSpec {
  readonly region: string;
  readonly cidr: string;
  /** Secondary ranges, e.g. for GKE pods/services. */
  readonly secondary?: Array<{ readonly name: string; readonly cidr: string }>;
}

export interface SharedVpcHostProps {
  /** Host project id. */
  readonly project: string;
  readonly networkName: string;
  readonly subnets: RegionalSubnetSpec[];
  /** Providers keyed by region (from `regionalProviders`). */
  readonly providers: RegionalProviders;
  /** Resources that must exist first (typically the compute API `ProjectService`). */
  readonly dependsOn?: ITerraformDependable[];
}

/**
 * The Shared VPC host: one VPC, one subnet per region (each created through
 * that region's provider alias), one Cloud NAT per region, and the project
 * marked as a host. Service projects attach to it and their workloads get NICs
 * in these subnets while IAM, firewall and routing stay with the network team.
 */
export class SharedVpcHost extends Construct {
  readonly network: ComputeNetwork;
  readonly subnets: Record<string, ComputeSubnetwork> = {};
  readonly host: ComputeSharedVpcHostProject;

  constructor(scope: Construct, id: string, props: SharedVpcHostProps) {
    super(scope, id);
    this.network = new ComputeNetwork(this, 'Network', {
      name: props.networkName,
      project: props.project,
      autoCreateSubnetworks: false,
      routingMode: 'GLOBAL',
      deleteDefaultRoutesOnCreate: false,
      dependsOn: props.dependsOn,
    });

    this.host = new ComputeSharedVpcHostProject(this, 'Host', { project: props.project, dependsOn: props.dependsOn });

    for (const spec of props.subnets) {
      const provider = props.providers[spec.region];
      if (!provider) throw new Error(`SharedVpcHost ${id}: no provider alias for region ${spec.region}`);
      const short = regionShortCode(spec.region);
      const subnet = new ComputeSubnetwork(this, `Subnet${short.toUpperCase()}`, {
        provider,
        name: `${props.networkName}-${short}`,
        project: props.project,
        region: spec.region,
        network: this.network.id,
        ipCidrRange: spec.cidr,
        privateIpGoogleAccess: true, // reach Google APIs without external IPs
        secondaryIpRange: spec.secondary?.map((s) => ({ rangeName: s.name, ipCidrRange: s.cidr })),
        logConfig: { aggregationInterval: 'INTERVAL_5_MIN', flowSampling: 0.5, metadata: 'INCLUDE_ALL_METADATA' },
      });
      this.subnets[spec.region] = subnet;

      // Cloud NAT is regional; `google_compute_router` takes its region from
      // the provider when omitted — one of the places the alias matters.
      const router = new ComputeRouter(this, `Router${short.toUpperCase()}`, {
        provider,
        name: `${props.networkName}-${short}-router`,
        project: props.project,
        region: spec.region,
        network: this.network.id,
      });
      new ComputeRouterNat(this, `Nat${short.toUpperCase()}`, {
        provider,
        name: `${props.networkName}-${short}-nat`,
        project: props.project,
        region: spec.region,
        router: router.name,
        natIpAllocateOption: 'AUTO_ONLY',
        sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
        subnetwork: [{ name: subnet.id, sourceIpRangesToNat: ['ALL_IP_RANGES'] }],
        logConfig: { enable: true, filter: 'ERRORS_ONLY' },
      });
    }
  }
}

export interface SharedVpcServiceAttachmentProps {
  readonly hostProject: string;
  readonly serviceProject: string;
  /** The host's subnets the service project may use. */
  readonly subnets: ComputeSubnetwork[];
  /**
   * Principals in the service project that need `roles/compute.networkUser`
   * on those subnets: workload SAs, and the Google service agents that create
   * NICs on the workload's behalf (Cloud Run, GKE, Cloud SQL...). Sub-net level,
   * not project level: a service project sees only the subnets it is granted.
   */
  readonly networkUsers: string[];
  /** Provider for the *service* project side (attachment is a service-project resource). */
  readonly serviceProvider?: GoogleProvider;
  readonly dependsOn?: ITerraformDependable[];
}

/**
 * Attaches a service project to the host and grants subnet-level network use.
 * The attachment is 1:1 (a project is a service project of at most one host);
 * the IAM is per subnet per principal.
 */
export class SharedVpcServiceAttachment extends Construct {
  readonly attachment: ComputeSharedVpcServiceProject;
  readonly grants: ComputeSubnetworkIamMember[] = [];

  constructor(scope: Construct, id: string, props: SharedVpcServiceAttachmentProps) {
    super(scope, id);
    this.attachment = new ComputeSharedVpcServiceProject(this, 'Attachment', {
      hostProject: props.hostProject,
      serviceProject: props.serviceProject,
      // ABANDON: detaching on destroy is refused by the API while any workload
      // still holds a NIC; leaving the attachment is the safer failure.
      deletionPolicy: 'ABANDON',
      provider: props.serviceProvider,
      dependsOn: props.dependsOn,
    });

    props.subnets.forEach((subnet) => {
      props.networkUsers.forEach((member, i) => {
        this.grants.push(
          new ComputeSubnetworkIamMember(this, `NetworkUser${subnet.node.id}${i}`, {
            project: props.hostProject,
            region: subnet.region,
            subnetwork: subnet.name,
            role: 'roles/compute.networkUser',
            member,
            dependsOn: [this.attachment],
          }),
        );
      });
    });

  }
}
