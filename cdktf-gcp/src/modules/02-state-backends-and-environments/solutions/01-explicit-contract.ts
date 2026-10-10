/**
 * Exercise 1 — decouple the consumer from the producer's *code*.
 *
 * The automatic cross-stack reference is convenient but couples two stacks at
 * synth time: the consumer must be in the same App, must construct the
 * producer, and inherits a manifest dependency. Rewrite AppStack's consumption
 * of the VPC as a `terraform_remote_state` read of NetworkStack's *explicit*
 * `network_id` output. The producer can now be deployed from another
 * repository, by another team, on another schedule.
 */
import { DataTerraformRemoteStateGcs, DataTerraformRemoteStateLocal, TerraformOutput, TerraformRemoteState, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { ComputeFirewall } from '@cdktf/provider-google/lib/compute-firewall';
import { environmentFor, resourceName } from '@cdk-mastery/shared';
import { gcpProject, gcpRegion } from '../gcp-config';

export type StateSource =
  | { readonly kind: 'gcs'; readonly bucket: string; readonly prefix: string }
  | { readonly kind: 'local'; readonly path: string };

export interface ContractConsumerStackProps {
  readonly tier: string;
  /** Where the producer's state lives. Local is for laptops; GCS for everything else. */
  readonly networkState: StateSource;
  readonly project?: string;
}

export class ContractConsumerStack extends TerraformStack {
  readonly networkState: TerraformRemoteState;
  readonly firewall: ComputeFirewall;

  constructor(scope: Construct, id: string, props: ContractConsumerStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    new GoogleProvider(this, 'Google', { project: props.project ?? gcpProject(), region: gcpRegion() });

    this.networkState =
      props.networkState.kind === 'gcs'
        ? new DataTerraformRemoteStateGcs(this, 'Network', { bucket: props.networkState.bucket, prefix: props.networkState.prefix })
        : new DataTerraformRemoteStateLocal(this, 'Network', { path: props.networkState.path });

    // The contract is the output *name*. If the producer renames `network_id`,
    // this plan fails with "Unsupported attribute" — which is the correct
    // failure mode for a broken contract. No `defaults` on purpose.
    this.firewall = new ComputeFirewall(this, 'AllowHealthChecks', {
      name: resourceName({ org: 'cdkm', service: 'state', env: tier.name, component: 'allow-hc' }),
      network: this.networkState.getString('network_id'),
      direction: 'INGRESS',
      // Google's load-balancer health-check ranges.
      sourceRanges: ['35.191.0.0/16', '130.211.0.0/22'],
      allow: [{ protocol: 'tcp', ports: ['8080'] }],
    });

    new TerraformOutput(this, 'firewall_name', { value: this.firewall.name });
  }
}
