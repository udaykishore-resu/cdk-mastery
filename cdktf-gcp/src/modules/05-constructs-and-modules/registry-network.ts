import { TerraformHclModule } from 'cdktf';
import { Construct } from 'constructs';

export interface RegistrySubnet {
  readonly name: string;
  readonly cidr: string;
  readonly region: string;
  readonly privateGoogleAccess?: boolean;
  readonly secondaryRanges?: Record<string, string>;
}

export interface RegistryNetworkProps {
  readonly project: string;
  readonly networkName: string;
  readonly subnets: readonly RegistrySubnet[];
  readonly routingMode?: 'REGIONAL' | 'GLOBAL';
  /** Module version constraint; pin a minor in production. */
  readonly version?: string;
}

/**
 * The Terraform Registry module `terraform-google-modules/network/google`
 * (the "Cloud Foundation Fabric"-adjacent, Google-maintained VPC module)
 * consumed without generated bindings. `TerraformHclModule` takes `source`,
 * `version` and an untyped `variables` map, and exposes outputs through
 * `getString`/`getList`/`get`.
 *
 * Trade-off: no type-checking on variables or outputs (a typo is a plan-time
 * error), but no `cdktf get` step, no `.gen/` directory, and the module's own
 * versioning applies. A thin typed wrapper like this class gives consumers the
 * type safety back at the boundary that matters.
 *
 * `terraform init` downloads the module; synth does not need network access.
 */
export class RegistryNetwork extends Construct {
  readonly module: TerraformHclModule;
  /** Output `network_name`. */
  readonly networkName: string;
  /** Output `network_id` (projects/…/global/networks/…). */
  readonly networkId: string;
  /** Output `subnets_ids`, a list token. */
  readonly subnetIds: string[];

  constructor(scope: Construct, id: string, props: RegistryNetworkProps) {
    super(scope, id);

    // The module's input shape, translated from our typed props. Keys are the
    // module's variable names exactly; this is where a typo would hide.
    const subnets = props.subnets.map((s) => ({
      subnet_name: s.name,
      subnet_ip: s.cidr,
      subnet_region: s.region,
      subnet_private_access: String(s.privateGoogleAccess ?? true),
    }));
    const secondaryRanges = Object.fromEntries(
      props.subnets
        .filter((s) => s.secondaryRanges && Object.keys(s.secondaryRanges).length > 0)
        .map((s) => [s.name, Object.entries(s.secondaryRanges ?? {}).map(([range_name, ip_cidr_range]) => ({ range_name, ip_cidr_range }))]),
    );

    this.module = new TerraformHclModule(this, 'Vpc', {
      source: 'terraform-google-modules/network/google',
      version: props.version ?? '~> 11.0',
      variables: {
        project_id: props.project,
        network_name: props.networkName,
        routing_mode: props.routingMode ?? 'REGIONAL',
        subnets,
        secondary_ranges: secondaryRanges,
      },
    });

    this.networkName = this.module.getString('network_name');
    this.networkId = this.module.getString('network_id');
    this.subnetIds = this.module.getList('subnets_ids');
  }
}
