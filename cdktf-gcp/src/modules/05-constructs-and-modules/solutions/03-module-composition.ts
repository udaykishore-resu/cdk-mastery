/**
 * Exercise 3 — compose two Registry modules and expose a typed boundary.
 *
 * Add Cloud NAT (`terraform-google-modules/cloud-nat/google`) on top of
 * `RegistryNetwork`. Module-to-module wiring is just tokens: the NAT module's
 * `network` variable receives the VPC module's `network_name` output, and
 * `dependsOn` orders modules that share no output edge. Wrap it in a
 * construct that implements a small `IVpc` interface so consumers (a Cloud
 * Run stack, a GKE stack) depend on the interface, not on the module.
 */
import { TerraformHclModule } from 'cdktf';
import { Construct, IConstruct } from 'constructs';
import { RegistryNetwork, RegistryNetworkProps } from '../registry-network';

export interface IVpc extends IConstruct {
  readonly networkName: string;
  readonly networkId: string;
  readonly subnetIds: string[];
  /** Name of the NAT gateway, if egress is provided. */
  readonly natName?: string;
}

export interface RegistryVpcWithNatProps extends RegistryNetworkProps {
  readonly region: string;
  /** Log only errors (default) or everything. */
  readonly natLogFilter?: 'ERRORS_ONLY' | 'TRANSLATIONS_ONLY' | 'ALL';
}

export class RegistryVpcWithNat extends Construct implements IVpc {
  readonly network: RegistryNetwork;
  readonly nat: TerraformHclModule;
  readonly networkName: string;
  readonly networkId: string;
  readonly subnetIds: string[];
  readonly natName: string;

  constructor(scope: Construct, id: string, props: RegistryVpcWithNatProps) {
    super(scope, id);
    this.network = new RegistryNetwork(this, 'Vpc', props);

    this.nat = new TerraformHclModule(this, 'Nat', {
      source: 'terraform-google-modules/cloud-nat/google',
      version: '~> 5.0',
      variables: {
        project_id: props.project,
        region: props.region,
        router: `${props.networkName}-router`,
        create_router: true,
        // Output of one module feeding a variable of another: an implicit edge.
        network: this.network.networkName,
        name: `${props.networkName}-nat`,
        log_config_enable: true,
        log_config_filter: props.natLogFilter ?? 'ERRORS_ONLY',
        enable_dynamic_port_allocation: true,
      },
      // The edge above already orders them; dependsOn is for module pairs
      // with no data edge (e.g. a firewall module that must follow the VPC).
      dependsOn: [this.network.module],
    });

    this.networkName = this.network.networkName;
    this.networkId = this.network.networkId;
    this.subnetIds = this.network.subnetIds;
    this.natName = this.nat.getString('name');
  }
}
