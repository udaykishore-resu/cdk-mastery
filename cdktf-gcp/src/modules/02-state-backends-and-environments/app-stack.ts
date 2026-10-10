import { DataTerraformRemoteStateGcs, TerraformOutput, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { ComputeAddress } from '@cdktf/provider-google/lib/compute-address';
import { ComputeFirewall } from '@cdktf/provider-google/lib/compute-firewall';
import { environmentFor, resourceName } from '@cdk-mastery/shared';
import { configureBackend, StateBackendOptions } from './backend';
import { gcpProject, gcpRegion } from './gcp-config';
import { NetworkStack } from './network-stack';

export interface LegacyStateLocation {
  /** GCS bucket holding the HCL-managed stack's state. */
  readonly bucket: string;
  /** Prefix (folder) of that state, e.g. `legacy/network`. */
  readonly prefix: string;
}

export interface AppStackProps {
  readonly tier: string;
  /** Producer stack in the same App; referencing its resources creates a cross-stack reference. */
  readonly network: NetworkStack;
  /**
   * Where an *HCL-managed* network stack keeps its state. When set, this stack
   * reads that stack's `subnet_self_link` output through `terraform_remote_state`
   * instead of trusting a TypeScript reference. Optional so the module synths offline.
   */
  readonly legacyState?: LegacyStateLocation;
  readonly project?: string;
  readonly region?: string;
  readonly state?: StateBackendOptions;
}

/**
 * The *consumer*. Two kinds of "someone else's resource" appear here:
 *
 *   - `props.network.network.id`: a token that belongs to another TerraformStack
 *     in this App. CDKTF notices at `prepareStack()` time (an App.synth() step
 *     that the testing helpers skip unless you call it), registers a sensitive
 *     output on the producer and a `terraform_remote_state` data source here,
 *     and records the dependency in manifest.json so `cdktf deploy '*'` orders them.
 *   - `DataTerraformRemoteStateGcs`: an explicit data source against a state file
 *     you know the location of. This is how you consume outputs of stacks that
 *     are not CDKTF, not in this repo, or deployed by another team.
 */
export class AppStack extends TerraformStack {
  readonly firewall: ComputeFirewall;
  readonly legacyAddress?: ComputeAddress;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    const region = props.region ?? gcpRegion();
    new GoogleProvider(this, 'Google', { project: props.project ?? gcpProject(), region });
    configureBackend(this, `${id}`, props.state);

    // Implicit cross-stack reference: nothing here says "remote state". The
    // synthesized JSON does — see the test.
    this.firewall = new ComputeFirewall(this, 'AllowIapSsh', {
      name: resourceName({ org: 'cdkm', service: 'state', env: tier.name, component: 'allow-iap-ssh' }),
      network: props.network.network.id,
      direction: 'INGRESS',
      sourceRanges: ['35.235.240.0/20'],
      allow: [{ protocol: 'tcp', ports: ['22'] }],
    });

    if (props.legacyState) {
      const legacy = new DataTerraformRemoteStateGcs(this, 'LegacyNetwork', {
        bucket: props.legacyState.bucket,
        prefix: props.legacyState.prefix,
        // `defaults` are what you get when the output does not exist (yet).
        // Without them a missing output is a hard plan error; with them you get
        // an empty string and a confusing apply error later. Prefer failing early
        // unless the consumer can genuinely run without the value.
        defaults: {},
      });
      this.legacyAddress = new ComputeAddress(this, 'LegacyInternalIp', {
        name: resourceName({ org: 'cdkm', service: 'state', env: tier.name, component: 'legacy-ip', region }),
        region,
        addressType: 'INTERNAL',
        subnetwork: legacy.getString('subnet_self_link'),
      });
      new TerraformOutput(this, 'legacy_internal_ip', { value: this.legacyAddress.address });
    }

    new TerraformOutput(this, 'firewall_self_link', { value: this.firewall.selfLink });
  }
}
