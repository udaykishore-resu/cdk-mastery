import { TerraformOutput } from 'cdktf';
import { Construct } from 'constructs';
import { ComputeGlobalAddress } from '@cdktf/provider-google/lib/compute-global-address';
import { ComputeNetwork } from '@cdktf/provider-google/lib/compute-network';
import { ComputeRouter } from '@cdktf/provider-google/lib/compute-router';
import { ComputeRouterNat } from '@cdktf/provider-google/lib/compute-router-nat';
import { ComputeSubnetwork } from '@cdktf/provider-google/lib/compute-subnetwork';
import { ServiceNetworkingConnection } from '@cdktf/provider-google/lib/service-networking-connection';
import { PlatformContext, PlatformStack } from '../platform-stack';

export interface NetworkStackProps {
  readonly ctx: PlatformContext;
  /** Primary subnet CIDR; distinct per environment so VPC peering stays possible later. */
  readonly cidr: string;
}

/**
 * `m11-<env>-network`: custom-mode VPC, one regional subnet (Cloud Run direct
 * VPC egress and Functions land here), Cloud NAT for egress without external
 * IPs, and Private Service Access — the reserved range + peering that Cloud
 * SQL private IP requires. The data stack references `network.id`, so
 * `cdktf deploy` applies this stack first; PSA is part of it precisely so the
 * SQL instance never races the peering.
 */
export class NetworkStack extends PlatformStack {
  readonly network: ComputeNetwork;
  readonly subnet: ComputeSubnetwork;
  readonly nat: ComputeRouterNat;
  readonly privateServiceAccess: ServiceNetworkingConnection;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props.ctx);
    const { region, tier } = this.ctx;

    this.network = new ComputeNetwork(this, 'Vpc', {
      name: this.name('vpc'),
      autoCreateSubnetworks: false,
      routingMode: 'REGIONAL',
    });

    this.subnet = new ComputeSubnetwork(this, 'Subnet', {
      name: this.name('subnet'),
      region,
      network: this.network.id,
      ipCidrRange: props.cidr,
      privateIpGoogleAccess: true,
      logConfig: tier.highlyAvailable ? { aggregationInterval: 'INTERVAL_5_MIN', flowSampling: 0.25, metadata: 'INCLUDE_ALL_METADATA' } : undefined,
    });

    const router = new ComputeRouter(this, 'Router', { name: this.name('router'), region, network: this.network.id });
    this.nat = new ComputeRouterNat(this, 'Nat', {
      name: this.name('nat'),
      region,
      router: router.name,
      natIpAllocateOption: 'AUTO_ONLY',
      sourceSubnetworkIpRangesToNat: 'ALL_SUBNETWORKS_ALL_IP_RANGES',
      logConfig: { enable: true, filter: 'ERRORS_ONLY' },
    });

    // Private Service Access: a /16 out of the VPC's free space that Google
    // uses for managed services' internal IPs, peered to servicenetworking.
    const psaRange = new ComputeGlobalAddress(this, 'PsaRange', {
      name: this.name('psa'),
      purpose: 'VPC_PEERING',
      addressType: 'INTERNAL',
      prefixLength: 16,
      network: this.network.id,
    });
    this.privateServiceAccess = new ServiceNetworkingConnection(this, 'PrivateServiceAccess', {
      network: this.network.id,
      service: 'servicenetworking.googleapis.com',
      reservedPeeringRanges: [psaRange.name],
      // ABANDON: the peering cannot be deleted while a Cloud SQL instance uses
      // it; leaving it is safer than a destroy that fails half-way.
      deletionPolicy: 'ABANDON',
    });

    new TerraformOutput(this, 'NetworkId', { value: this.network.id });
    new TerraformOutput(this, 'SubnetName', { value: this.subnet.name });
  }
}
