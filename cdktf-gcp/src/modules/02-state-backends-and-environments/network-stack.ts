import { TerraformOutput, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { ComputeNetwork } from '@cdktf/provider-google/lib/compute-network';
import { ComputeSubnetwork } from '@cdktf/provider-google/lib/compute-subnetwork';
import { environmentFor, resourceName } from '@cdk-mastery/shared';
import { configureBackend, StateBackendOptions } from './backend';
import { gcpProject, gcpRegion } from './gcp-config';

export interface NetworkStackProps {
  readonly tier: string;
  readonly project?: string;
  readonly region?: string;
  readonly state?: StateBackendOptions;
}

/**
 * The *producer* in the cross-stack story. It owns a VPC and a subnet and, on
 * purpose, exposes them two ways:
 *
 *   1. as TypeScript properties (`network`, `subnet`) — consumed by AppStack in
 *      the same App; CDKTF turns the reference into an output here and a
 *      `terraform_remote_state` data source there (see the README).
 *   2. as an explicit, named `TerraformOutput` (`network_id`) — the contract for
 *      consumers that are *not* in this App: HCL, another repository, a script.
 */
export class NetworkStack extends TerraformStack {
  readonly network: ComputeNetwork;
  readonly subnet: ComputeSubnetwork;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    const region = props.region ?? gcpRegion();
    new GoogleProvider(this, 'Google', { project: props.project ?? gcpProject(), region });
    configureBackend(this, `${id}`, props.state);

    this.network = new ComputeNetwork(this, 'Vpc', {
      name: resourceName({ org: 'cdkm', service: 'state', env: tier.name, component: 'vpc' }),
      autoCreateSubnetworks: false,
      routingMode: 'REGIONAL',
    });
    this.subnet = new ComputeSubnetwork(this, 'Subnet', {
      name: resourceName({ org: 'cdkm', service: 'state', env: tier.name, component: 'subnet', region }),
      network: this.network.id,
      region,
      ipCidrRange: '10.20.0.0/24',
      privateIpGoogleAccess: true,
    });

    // The explicit contract. Name it like an API: stable, documented, versioned by convention.
    new TerraformOutput(this, 'network_id', { value: this.network.id, description: 'Full resource id of the VPC' });
    new TerraformOutput(this, 'subnet_self_link', { value: this.subnet.selfLink });
  }
}
