import { TerraformOutput, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { ComputeSubnetwork } from '@cdktf/provider-google/lib/compute-subnetwork';
import { EnvironmentTier, environmentFor, resourceName } from '@cdk-mastery/shared';
import { ServiceAgents } from './beta';
import { LandingZoneFolders } from './folders';
import { billingAccount, gcpProject, gcpRegion, identityDomain, orgId } from './org-config';
import { GcpProject } from './project-factory';
import { regionalProviders } from './regional-providers';
import { RegionalSubnetSpec, SharedVpcHost, SharedVpcServiceAttachment } from './shared-vpc';

/** Regions and CIDRs per environment; the config that drives every stack below. */
export const NETWORK_LAYOUT: Record<string, RegionalSubnetSpec[]> = {
  dev: [{ region: 'us-central1', cidr: '10.10.0.0/20' }],
  staging: [{ region: 'us-central1', cidr: '10.20.0.0/20' }],
  prod: [
    { region: 'us-central1', cidr: '10.30.0.0/20', secondary: [{ name: 'pods', cidr: '10.130.0.0/16' }] },
    { region: 'europe-west4', cidr: '10.31.0.0/20', secondary: [{ name: 'pods', cidr: '10.131.0.0/16' }] },
  ],
};

export interface FoldersStackProps {
  readonly orgId?: string;
  readonly identityDomain?: string;
  /** Provider project for API calls (the seed project). */
  readonly project?: string;
}

/** `m09-folders`: the tree and everything inherited from it. Applied once, by the org admin identity. */
export class FoldersStack extends TerraformStack {
  readonly folders: LandingZoneFolders;

  constructor(scope: Construct, id: string, props: FoldersStackProps = {}) {
    super(scope, id);
    new GoogleProvider(this, 'Google', { project: props.project ?? gcpProject(), region: gcpRegion() });
    this.folders = new LandingZoneFolders(this, 'Platform', {
      parent: `organizations/${props.orgId ?? orgId()}`,
      name: 'platform',
      identityDomain: props.identityDomain ?? identityDomain(),
    });
    for (const [env, folder] of Object.entries(this.folders.byEnvironment)) {
      new TerraformOutput(this, `Folder${env.charAt(0).toUpperCase()}${env.slice(1)}Id`, { value: folder.folderId });
    }
  }
}

export interface HostStackProps {
  readonly tier: string;
  /** Numeric folder id for this environment (cross-stack from FoldersStack, or literal). */
  readonly folderId: string;
  readonly billingAccount?: string;
  readonly org?: string;
  readonly subnets?: RegionalSubnetSpec[];
}

/** `m09-<env>-host`: the Shared VPC host project for one environment. */
export class HostStack extends TerraformStack {
  readonly tier: EnvironmentTier;
  readonly project: GcpProject;
  readonly vpc: SharedVpcHost;

  constructor(scope: Construct, id: string, props: HostStackProps) {
    super(scope, id);
    this.tier = environmentFor(props.tier);
    const org = props.org ?? 'cdkm';
    const projectId = resourceName({ org, service: 'net', env: this.tier.name, component: 'host' });
    const subnets = props.subnets ?? NETWORK_LAYOUT[this.tier.name];
    const regions = subnets.map((s) => s.region);

    // The un-aliased provider targets the project being created; project
    // creation itself goes through it too (resource manager is global).
    const providers = regionalProviders(this, { project: projectId, regions });

    this.project = new GcpProject(this, 'HostProject', {
      projectId,
      folderId: props.folderId,
      billingAccount: props.billingAccount ?? billingAccount(),
      tier: this.tier,
      service: 'network',
      apis: ['compute.googleapis.com', 'dns.googleapis.com', 'servicenetworking.googleapis.com'],
      monthlyBudgetUsd: this.tier.highlyAvailable ? 300 : 60,
    });
    const computeApi = this.project.services.find((s) => s.serviceInput === 'compute.googleapis.com')!;

    this.vpc = new SharedVpcHost(this, 'SharedVpc', {
      project: projectId,
      networkName: resourceName({ org, service: 'net', env: this.tier.name, component: 'vpc' }),
      subnets,
      providers,
      dependsOn: [computeApi],
    });

    new TerraformOutput(this, 'HostProjectId', { value: this.project.project.projectId });
    new TerraformOutput(this, 'NetworkSelfLink', { value: this.vpc.network.selfLink });
  }
}

export interface ServiceProjectStackProps {
  readonly tier: string;
  readonly service: string;
  readonly folderId: string;
  /** The host stack whose VPC this project attaches to. Cross-stack references are generated automatically. */
  readonly host: HostStack;
  readonly billingAccount?: string;
  readonly org?: string;
  readonly apis?: string[];
  readonly identityDomain?: string;
}

/**
 * `m09-<env>-<service>`: a workload project attached to the environment's
 * Shared VPC. Everything it needs from the host (project id, subnet names and
 * regions) is read off the `HostStack` object; CDKTF turns each read into a
 * `terraform_remote_state` output/input pair, and `cdktf deploy` orders the
 * stacks accordingly.
 */
export class ServiceProjectStack extends TerraformStack {
  readonly tier: EnvironmentTier;
  readonly project: GcpProject;
  readonly agents: ServiceAgents;
  readonly attachment: SharedVpcServiceAttachment;

  constructor(scope: Construct, id: string, props: ServiceProjectStackProps) {
    super(scope, id);
    this.tier = environmentFor(props.tier);
    const org = props.org ?? 'cdkm';
    const projectId = resourceName({ org, service: props.service, env: this.tier.name, component: 'svc' });
    const region = props.host.vpc.subnets[gcpRegion()] ? gcpRegion() : Object.keys(props.host.vpc.subnets)[0];
    const domain = props.identityDomain ?? identityDomain();

    // One un-aliased provider for the service project. Host-project resources
    // (subnet IAM) set `project:` explicitly, which is all GCP needs; no alias.
    new GoogleProvider(this, 'Google', { project: projectId, region });

    this.project = new GcpProject(this, 'ServiceProject', {
      projectId,
      folderId: props.folderId,
      billingAccount: props.billingAccount ?? billingAccount(),
      tier: this.tier,
      service: props.service,
      apis: ['compute.googleapis.com', 'run.googleapis.com', 'sqladmin.googleapis.com', 'vpcaccess.googleapis.com', ...(props.apis ?? [])],
      groupRoles: {
        'roles/viewer': [`group:${props.service}-team@${domain}`],
        ...(this.tier.requiresApproval ? {} : { 'roles/run.developer': [`group:${props.service}-team@${domain}`] }),
      },
      monthlyBudgetUsd: this.tier.highlyAvailable ? 500 : 100,
    });
    const computeApi = this.project.services.find((s) => s.serviceInput === 'compute.googleapis.com')!;

    // Beta-only: materialise the Cloud Run and Cloud SQL service agents so they
    // can be granted subnet access *before* the first service/instance exists.
    this.agents = new ServiceAgents(this, 'Agents', {
      project: projectId,
      region,
      services: ['run.googleapis.com', 'sqladmin.googleapis.com'],
      dependsOn: this.project.services,
    });

    const hostSubnets: ComputeSubnetwork[] = Object.values(props.host.vpc.subnets);
    this.attachment = new SharedVpcServiceAttachment(this, 'SharedVpc', {
      hostProject: props.host.project.project.projectId,
      serviceProject: this.project.project.projectId,
      subnets: hostSubnets,
      networkUsers: [this.agents.member('run.googleapis.com'), this.agents.member('sqladmin.googleapis.com')],
      dependsOn: [computeApi],
    });

    new TerraformOutput(this, 'ProjectId', { value: this.project.project.projectId });
    new TerraformOutput(this, 'ProjectNumber', { value: this.project.project.number });
  }
}
