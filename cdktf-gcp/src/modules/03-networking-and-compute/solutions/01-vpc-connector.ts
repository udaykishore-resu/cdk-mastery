/**
 * Exercise 1 — the other VPC egress path: a Serverless VPC Access connector.
 *
 * Direct VPC egress (what CloudRunStack uses) puts the revision on the subnet.
 * The connector is the older model: a small pool of e2-micro VMs that proxy
 * traffic into the VPC. You still need it when
 *   - the subnet cannot spare IPs (direct egress consumes one per instance, /24 minimum),
 *   - Cloud Functions gen1 or App Engine standard must reach the VPC,
 *   - an org policy forbids direct egress.
 * It costs money 24×7 (min 2 instances) and adds a hop. Build the connector on
 * its own /28 and a function that returns the `vpcAccess` block Cloud Run
 * needs, so a service can switch between the two models with one prop.
 */
import { Construct } from 'constructs';
import { CloudRunV2ServiceTemplateVpcAccess } from '@cdktf/provider-google/lib/cloud-run-v2-service';
import { ComputeSubnetwork } from '@cdktf/provider-google/lib/compute-subnetwork';
import { VpcAccessConnector } from '@cdktf/provider-google/lib/vpc-access-connector';
import { environmentFor, resourceName } from '@cdk-mastery/shared';

export interface ServerlessConnectorProps {
  readonly tier: string;
  readonly region: string;
  /** VPC id or self link. */
  readonly networkId: string;
  /** A dedicated /28 that nothing else uses; the connector owns it. */
  readonly cidr: string;
}

export class ServerlessConnector extends Construct {
  readonly subnet: ComputeSubnetwork;
  readonly connector: VpcAccessConnector;

  constructor(scope: Construct, id: string, props: ServerlessConnectorProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    if (!/\/28$/.test(props.cidr)) {
      throw new Error(`Serverless VPC Access connectors require a /28 subnet, got ${props.cidr}`);
    }
    const name = resourceName({ org: 'cdkm', service: 'net', env: tier.name, component: 'connector', region: props.region });

    this.subnet = new ComputeSubnetwork(this, 'Subnet', {
      name,
      network: props.networkId,
      region: props.region,
      ipCidrRange: props.cidr,
      privateIpGoogleAccess: true,
    });
    this.connector = new VpcAccessConnector(this, 'Connector', {
      name: name.slice(0, 25), // connector names are limited to 25 chars
      region: props.region,
      subnet: { name: this.subnet.name },
      machineType: tier.highlyAvailable ? 'e2-standard-4' : 'e2-micro',
      minInstances: 2,
      maxInstances: tier.highlyAvailable ? 10 : 3,
    });
  }

  /** The `template.vpcAccess` block for a Cloud Run v2 service or job. */
  vpcAccess(egress: 'PRIVATE_RANGES_ONLY' | 'ALL_TRAFFIC' = 'PRIVATE_RANGES_ONLY'): CloudRunV2ServiceTemplateVpcAccess {
    return { connector: this.connector.id, egress };
  }
}

/** Direct VPC egress, for comparison: no extra resources, one block. */
export function directVpcAccess(networkId: string, subnetId: string, tags: string[] = []): CloudRunV2ServiceTemplateVpcAccess {
  return { egress: 'PRIVATE_RANGES_ONLY', networkInterfaces: [{ network: networkId, subnetwork: subnetId, tags }] };
}
