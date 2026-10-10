import { TerraformOutput, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { ComputeNetwork } from '@cdktf/provider-google/lib/compute-network';
import { ComputeSubnetwork } from '@cdktf/provider-google/lib/compute-subnetwork';
import { ComputeRouter } from '@cdktf/provider-google/lib/compute-router';
import { ComputeRouterNat } from '@cdktf/provider-google/lib/compute-router-nat';
import { ComputeFirewall } from '@cdktf/provider-google/lib/compute-firewall';
import { ComputeGlobalAddress } from '@cdktf/provider-google/lib/compute-global-address';
import { ServiceNetworkingConnection } from '@cdktf/provider-google/lib/service-networking-connection';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { environmentFor, EnvironmentTier, resourceName } from '@cdk-mastery/shared';
import { gcpProject, gcpRegion } from './gcp-config';
import { ProjectServices } from './services';

/** Google's IAP TCP-forwarding source range. SSH/RDP arrive from here, never from the internet. */
export const IAP_RANGE = '35.235.240.0/20';
/** Google Cloud load-balancer health-check source ranges. */
export const HEALTH_CHECK_RANGES = ['35.191.0.0/16', '130.211.0.0/22'];

export interface NetworkStackProps {
  readonly tier: string;
  readonly project?: string;
  readonly region?: string;
  /** Primary range for the workload subnet. /24 is the minimum for Cloud Run direct VPC egress. */
  readonly subnetCidr?: string;
  /** Secondary ranges reserved now so a GKE cluster later needs no subnet surgery. */
  readonly podsCidr?: string;
  readonly servicesCidr?: string;
}

/**
 * A custom-mode VPC with everything a private workload needs and nothing else:
 *
 *   ComputeNetwork (auto_create_subnetworks = false, REGIONAL routing)
 *   └── ComputeSubnetwork (Private Google Access, secondary ranges, flow logs in prod)
 *   ComputeRouter + ComputeRouterNat            egress for private instances/Cloud Run
 *   ComputeFirewall × 3                         internal, IAP→SSH by service account, LB health checks
 *   ComputeGlobalAddress + ServiceNetworkingConnection   Private Service Access for Cloud SQL
 *   ServiceAccount "ssh-target"                 the identity firewall rules target instead of tags
 */
export class NetworkStack extends TerraformStack {
  readonly tier: EnvironmentTier;
  readonly region: string;
  readonly network: ComputeNetwork;
  readonly subnet: ComputeSubnetwork;
  readonly nat: ComputeRouterNat;
  readonly privateServiceRange: ComputeGlobalAddress;
  readonly privateServiceConnection: ServiceNetworkingConnection;
  readonly sshTargetAccount: ServiceAccount;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id);
    this.tier = environmentFor(props.tier);
    this.region = props.region ?? gcpRegion();
    const tier = this.tier;
    const region = this.region;
    new GoogleProvider(this, 'Google', { project: props.project ?? gcpProject(), region });

    const apis = new ProjectServices(this, 'Apis', ['compute.googleapis.com', 'servicenetworking.googleapis.com']);
    const name = (component: string) => resourceName({ org: 'cdkm', service: 'net', env: tier.name, component });
    const subnetCidr = props.subnetCidr ?? '10.10.0.0/24';
    const podsCidr = props.podsCidr ?? '10.16.0.0/14';
    const servicesCidr = props.servicesCidr ?? '10.20.0.0/20';

    // Custom mode: no auto subnets in every region (an attack surface and a
    // quota drain). REGIONAL routing keeps Cloud Router advertisements local;
    // GLOBAL is for multi-region interconnect setups.
    this.network = new ComputeNetwork(this, 'Vpc', {
      name: name('vpc'),
      autoCreateSubnetworks: false,
      routingMode: 'REGIONAL',
      // Default routes to the internet stay: NAT needs the 0.0.0.0/0 route.
      deleteDefaultRoutesOnCreate: false,
      dependsOn: apis.services,
    });

    this.subnet = new ComputeSubnetwork(this, 'Workloads', {
      name: name(`workloads-${region}`),
      network: this.network.id,
      region,
      ipCidrRange: subnetCidr,
      // Instances without external IPs still reach Google APIs (GCS, Secret
      // Manager, Artifact Registry) over internal routes.
      privateIpGoogleAccess: true,
      secondaryIpRange: [
        { rangeName: 'pods', ipCidrRange: podsCidr },
        { rangeName: 'services', ipCidrRange: servicesCidr },
      ],
      // Flow logs cost Logging ingestion; sample in prod, skip elsewhere.
      logConfig: tier.highlyAvailable
        ? { aggregationInterval: 'INTERVAL_5_MIN', flowSampling: 0.5, metadata: 'INCLUDE_ALL_METADATA' }
        : undefined,
    });

    // Cloud NAT: outbound internet for anything without an external IP. One
    // gateway per region; auto-allocated IPs unless you need allow-listing.
    const router = new ComputeRouter(this, 'Router', { name: name('router'), network: this.network.id, region });
    this.nat = new ComputeRouterNat(this, 'Nat', {
      name: name('nat'),
      router: router.name,
      region,
      natIpAllocateOption: 'AUTO_ONLY',
      sourceSubnetworkIpRangesToNat: 'ALL_SUBNETWORKS_ALL_IP_RANGES',
      // Dynamic port allocation avoids the classic "NAT port exhaustion" outage
      // when a few instances open many connections.
      enableDynamicPortAllocation: true,
      minPortsPerVm: 64,
      maxPortsPerVm: 4096,
      logConfig: { enable: true, filter: 'ERRORS_ONLY' },
    });

    // Firewall: identity, not tags. Tags can be set by anyone with
    // compute.instances.setTags; a service account is an IAM decision.
    this.sshTargetAccount = new ServiceAccount(this, 'SshTarget', {
      accountId: name('ssh'),
      displayName: 'Instances that accept SSH via IAP',
    });

    new ComputeFirewall(this, 'AllowInternal', {
      name: name('allow-internal'),
      network: this.network.id,
      direction: 'INGRESS',
      priority: 1000,
      sourceRanges: [subnetCidr, podsCidr, servicesCidr],
      allow: [{ protocol: 'tcp' }, { protocol: 'udp' }, { protocol: 'icmp' }],
    });

    new ComputeFirewall(this, 'AllowIapSsh', {
      name: name('allow-iap-ssh'),
      network: this.network.id,
      direction: 'INGRESS',
      priority: 900,
      sourceRanges: [IAP_RANGE],
      targetServiceAccounts: [this.sshTargetAccount.email],
      allow: [{ protocol: 'tcp', ports: ['22'] }],
      logConfig: { metadata: 'INCLUDE_ALL_METADATA' },
    });

    new ComputeFirewall(this, 'AllowHealthChecks', {
      name: name('allow-health-checks'),
      network: this.network.id,
      direction: 'INGRESS',
      priority: 900,
      sourceRanges: HEALTH_CHECK_RANGES,
      allow: [{ protocol: 'tcp', ports: ['8080', '80', '443'] }],
    });

    // Private Service Access: a /16 of *our* address space handed to Google so
    // managed services (Cloud SQL, Memorystore, AlloyDB) get private IPs
    // reachable from the VPC through a VPC peering that Google operates.
    this.privateServiceRange = new ComputeGlobalAddress(this, 'PrivateServiceRange', {
      name: name('psa-range'),
      purpose: 'VPC_PEERING',
      addressType: 'INTERNAL',
      prefixLength: 16,
      network: this.network.id,
    });
    this.privateServiceConnection = new ServiceNetworkingConnection(this, 'PrivateServiceConnection', {
      network: this.network.id,
      service: 'servicenetworking.googleapis.com',
      reservedPeeringRanges: [this.privateServiceRange.name],
      // The peering cannot be deleted while a Cloud SQL instance uses it. ABANDON
      // lets `destroy` proceed (the peering is cleaned up when the VPC goes).
      deletionPolicy: 'ABANDON',
      dependsOn: apis.services,
    });

    new TerraformOutput(this, 'network_id', { value: this.network.id });
    new TerraformOutput(this, 'subnet_id', { value: this.subnet.id });
    new TerraformOutput(this, 'nat_name', { value: this.nat.name });
    new TerraformOutput(this, 'ssh_target_service_account', { value: this.sshTargetAccount.email });
  }
}
