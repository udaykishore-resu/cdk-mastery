/**
 * Exercise 2 — a bastion you can only reach through IAP.
 *
 * No external IP, Shielded VM, OS Login (IAM decides who may SSH, no metadata
 * keys), and the network stack's `ssh-target` service account so the
 * `allow-iap-ssh` firewall rule applies to it and to nothing else. Reaching it:
 *
 *   gcloud compute ssh cdkm-net-dev-bastion --tunnel-through-iap --zone us-central1-a
 *
 * which requires roles/iap.tunnelResourceAccessor and roles/compute.osLogin
 * (or osAdminLogin) on the caller. Put it in its own stack so it can be
 * destroyed when nobody needs it.
 */
import { Fn, TerraformOutput, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { ComputeInstance } from '@cdktf/provider-google/lib/compute-instance';
import { DataGoogleComputeZones } from '@cdktf/provider-google/lib/data-google-compute-zones';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { environmentFor, mandatoryTags, resourceName } from '@cdk-mastery/shared';
import { gcpProject } from '../gcp-config';
import { NetworkStack } from '../network-stack';

export interface BastionStackProps {
  readonly tier: string;
  readonly network: NetworkStack;
  readonly project?: string;
  /** Principals allowed to tunnel and log in, e.g. `group:sre@example.com`. */
  readonly operators: readonly string[];
}

export class BastionStack extends TerraformStack {
  readonly instance: ComputeInstance;

  constructor(scope: Construct, id: string, props: BastionStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    const project = props.project ?? gcpProject();
    const region = props.network.region;
    new GoogleProvider(this, 'Google', { project, region });
    const zones = new DataGoogleComputeZones(this, 'Zones', { region, status: 'UP' });

    this.instance = new ComputeInstance(this, 'Bastion', {
      name: resourceName({ org: 'cdkm', service: 'net', env: tier.name, component: 'bastion' }),
      machineType: 'e2-micro',
      zone: Fn.element(zones.names, 0),
      labels: mandatoryTags(tier, 'bastion'),
      bootDisk: { initializeParams: { image: 'debian-cloud/debian-12', size: 10, type: 'pd-standard' } },
      // No accessConfig block = no external IP. Egress goes through Cloud NAT.
      networkInterface: [{ subnetwork: props.network.subnet.id }],
      // The firewall rule in NetworkStack targets this service account.
      serviceAccount: { email: props.network.sshTargetAccount.email, scopes: ['https://www.googleapis.com/auth/cloud-platform'] },
      shieldedInstanceConfig: { enableSecureBoot: true, enableVtpm: true, enableIntegrityMonitoring: true },
      metadata: { 'enable-oslogin': 'TRUE', 'block-project-ssh-keys': 'TRUE' },
      allowStoppingForUpdate: true,
      deletionProtection: false,
    });

    props.operators.forEach((member, i) => {
      // IAP tunnel + OS Login. Project-wide for brevity; per-instance IAP IAM
      // (google_iap_tunnel_instance_iam_member) is tighter.
      new ProjectIamMember(this, `Tunnel${i}`, { project, role: 'roles/iap.tunnelResourceAccessor', member });
      new ProjectIamMember(this, `OsLogin${i}`, { project, role: 'roles/compute.osLogin', member });
      // OS Login as a non-default service account requires actAs on it.
      new ProjectIamMember(this, `ActAs${i}`, { project, role: 'roles/iam.serviceAccountUser', member });
    });

    new TerraformOutput(this, 'ssh_command', {
      value: `gcloud compute ssh ${this.instance.name} --tunnel-through-iap --zone ${this.instance.zone} --project ${project}`,
    });
  }
}
