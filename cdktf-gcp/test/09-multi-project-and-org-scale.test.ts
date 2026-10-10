import { App, TerraformStack, Testing } from 'cdktf';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { GoogleBetaProvider } from '@cdktf/provider-google-beta/lib/provider';
import { GoogleProjectServiceIdentity } from '@cdktf/provider-google-beta/lib/google-project-service-identity';
import { BillingBudget } from '@cdktf/provider-google/lib/billing-budget';
import { ComputeNetwork } from '@cdktf/provider-google/lib/compute-network';
import { ComputeRouterNat } from '@cdktf/provider-google/lib/compute-router-nat';
import { ComputeSharedVpcHostProject } from '@cdktf/provider-google/lib/compute-shared-vpc-host-project';
import { ComputeSharedVpcServiceProject } from '@cdktf/provider-google/lib/compute-shared-vpc-service-project';
import { ComputeSubnetwork } from '@cdktf/provider-google/lib/compute-subnetwork';
import { ComputeSubnetworkIamMember } from '@cdktf/provider-google/lib/compute-subnetwork-iam-member';
import { Folder } from '@cdktf/provider-google/lib/folder';
import { FolderIamMember } from '@cdktf/provider-google/lib/folder-iam-member';
import { OrgPolicyPolicy } from '@cdktf/provider-google/lib/org-policy-policy';
import { Project } from '@cdktf/provider-google/lib/project';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { ProjectService } from '@cdktf/provider-google/lib/project-service';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import {
  BASE_APIS,
  DEVELOPER_ROLES,
  FoldersStack,
  GcpProject,
  HostStack,
  NETWORK_LAYOUT,
  ServiceProjectStack,
  enableApis,
  regionalProviders,
  validateProjectId,
} from '../src/modules/09-multi-project-and-org-scale';
import { projectIdFor } from '../src/modules/09-multi-project-and-org-scale/solutions/project-id';
import { API_BUNDLES, ProjectApis, resolveBundles } from '../src/modules/09-multi-project-and-org-scale/solutions/api-bundles';
import { ServiceAgentSubnetAccess, serviceAgentGrants } from '../src/modules/09-multi-project-and-org-scale/solutions/service-agent-subnet-access';

Testing.setupJest();

/** The full landing zone for one environment; consumers are prepared so cross-stack refs resolve. */
function landingZone(env: 'dev' | 'prod') {
  const app = Testing.app();
  const folders = new FoldersStack(app, 'm09-folders', { orgId: '111', identityDomain: 'example.com', project: 'seed' });
  const host = new HostStack(app, `m09-${env}-host`, { tier: env, folderId: folders.folders.byEnvironment[env].folderId, billingAccount: 'AAAAAA-BBBBBB-CCCCCC' });
  const service = new ServiceProjectStack(app, `m09-${env}-orders`, { tier: env, service: 'orders', folderId: folders.folders.byEnvironment[env].folderId, host, billingAccount: 'AAAAAA-BBBBBB-CCCCCC', identityDomain: 'example.com' });
  host.prepareStack();
  service.prepareStack();
  return { app, folders, host, service };
}

describe('09 · project factory (GcpProject)', () => {
  function project(tier: 'dev' | 'prod', extra: Partial<ConstructorParameters<typeof GcpProject>[2]> = {}) {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'factory');
    new GoogleProvider(stack, 'Google', { project: 'seed' });
    const p = new GcpProject(stack, 'Orders', {
      projectId: `cdkm-orders-${tier}`,
      folderId: '123',
      billingAccount: 'AAAAAA-BBBBBB-CCCCCC',
      tier: ENVIRONMENTS[tier],
      service: 'orders',
      apis: ['run.googleapis.com', 'sqladmin.googleapis.com', 'run.googleapis.com'],
      groupRoles: { 'roles/viewer': ['group:orders-team@example.com'] },
      monthlyBudgetUsd: 250,
      ...extra,
    });
    return { stack, p, synth: Testing.synth(stack) };
  }

  test('project: no default network, labels from the tier, deletion policy from the tier', () => {
    expect(project('prod').synth).toHaveResourceWithProperties(Project, {
      project_id: 'cdkm-orders-prod',
      folder_id: '123',
      billing_account: 'AAAAAA-BBBBBB-CCCCCC',
      auto_create_network: false,
      deletion_policy: 'PREVENT',
      labels: { environment: 'prod', service: 'orders', owner: 'platform-oncall', 'cost-center': 'cc-platform-prod', 'managed-by': 'cdk-mastery' },
    });
    expect(project('dev').synth).toHaveResourceWithProperties(Project, { deletion_policy: 'DELETE' });
    expect(project('prod', { deletionPolicy: 'ABANDON' }).synth).toHaveResourceWithProperties(Project, { deletion_policy: 'ABANDON' });
  });

  test('APIs: base APIs serialised, the rest gated on the last base API, de-duplicated, never disabled on destroy', () => {
    const json = JSON.parse(project('dev').synth);
    const services = json.resource.google_project_service as Record<string, { service: string; depends_on?: string[]; disable_on_destroy: boolean }>;
    const byService = Object.fromEntries(Object.entries(services).map(([id, s]) => [s.service, { id, ...s }]));
    expect(Object.keys(byService).sort()).toEqual([...BASE_APIS, 'run.googleapis.com', 'sqladmin.googleapis.com'].sort());
    expect(byService['cloudresourcemanager.googleapis.com'].depends_on).toBeUndefined();
    expect(byService['serviceusage.googleapis.com'].depends_on).toEqual([`google_project_service.${byService['cloudresourcemanager.googleapis.com'].id}`]);
    expect(byService['run.googleapis.com'].depends_on).toEqual([`google_project_service.${byService['cloudbilling.googleapis.com'].id}`]);
    expect(Object.values(services).every((s) => s.disable_on_destroy === false)).toBe(true);
  });

  test('IAM: groups only, depends on the resource manager API', () => {
    const { synth } = project('dev');
    expect(synth).toHaveResourceWithProperties(ProjectIamMember, { role: 'roles/viewer', member: 'group:orders-team@example.com', depends_on: [expect.stringMatching(/^google_project_service\./)] });
    expect(() => project('dev', { groupRoles: { 'roles/viewer': ['user:me@example.com'] } })).toThrow(/must be groups/);
  });

  test('budget: filtered to the project number, 50/90% actual and 100% forecast', () => {
    expect(project('dev').synth).toHaveResourceWithProperties(BillingBudget, {
      billing_account: 'AAAAAA-BBBBBB-CCCCCC',
      budget_filter: { projects: [expect.stringMatching(/^projects\/\$\{google_project\.Orders_Project_[0-9A-F]{8}\.number\}$/)], credit_types_treatment: 'INCLUDE_ALL_CREDITS' },
      amount: { specified_amount: { currency_code: 'USD', units: '250' } },
      threshold_rules: [{ threshold_percent: 0.5 }, { threshold_percent: 0.9 }, { threshold_percent: 1, spend_basis: 'FORECASTED_SPEND' }],
    });
  });

  test('project id validation', () => {
    expect(() => validateProjectId('ok-project-id')).not.toThrow();
    expect(() => validateProjectId('Bad')).toThrow(/6-30/);
    expect(() => validateProjectId('1starts-with-digit')).toThrow();
    expect(() => validateProjectId('ends-with-hyphen-')).toThrow();
    expect(() => validateProjectId('google-something')).toThrow(/reserved/);
  });
});

describe('09 · folders and inherited policy', () => {
  test('tree, folder-level org policies, group IAM per environment, prod extras', () => {
    const stack = new FoldersStack(Testing.app(), 'm09-folders', { orgId: '111', identityDomain: 'example.com', project: 'seed' });
    const synth = Testing.synth(stack);
    const json = JSON.parse(synth);
    expect(synth).toHaveResourceWithProperties(Folder, { display_name: 'platform', parent: 'organizations/111', deletion_protection: true });
    for (const env of Object.keys(ENVIRONMENTS)) {
      expect(synth).toHaveResourceWithProperties(Folder, { display_name: env, parent: expect.stringMatching(/^\$\{google_folder\.Platform_Root_[0-9A-F]{8}\.name\}$/) });
    }
    expect(synth).toHaveResourceWithProperties(OrgPolicyPolicy, { name: expect.stringMatching(/^\$\{google_folder\.Platform_Root_[0-9A-F]{8}\.name\}\/policies\/iam\.disableServiceAccountKeyCreation$/), spec: { rules: [{ enforce: 'TRUE' }] } });
    expect(synth).toHaveResourceWithProperties(OrgPolicyPolicy, { name: expect.stringContaining('/policies/iam.allowedPolicyMemberDomains') });
    // prod: security reviewer + no external IPs; dev: developer roles
    expect(synth).toHaveResourceWithProperties(FolderIamMember, { role: 'roles/iam.securityReviewer', member: 'group:gcp-security@example.com' });
    expect(synth).toHaveResourceWithProperties(OrgPolicyPolicy, { name: expect.stringContaining('compute.vmExternalIpAccess'), spec: { rules: [{ deny_all: 'TRUE' }] } });
    const members = Object.values<{ role: string; member: string; folder: string }>(json.resource.google_folder_iam_member);
    expect(members.filter((m) => m.member === 'group:gcp-dev-developers@example.com').map((m) => m.role).sort()).toEqual([...DEVELOPER_ROLES].sort());
    expect(members.some((m) => m.role === 'roles/editor' || m.role === 'roles/owner')).toBe(false);
    expect(members.every((m) => m.member.startsWith('group:'))).toBe(true);
    expect(Object.keys(json.output)).toEqual(['FolderDevId', 'FolderProdId', 'FolderStagingId']);
    expect(() => Testing.fullSynth(stack)).not.toThrow();
  });
});

describe('09 · Shared VPC host with per-region provider aliases', () => {
  test('prod host: two regions, aliased provider on EU resources, NAT per region, host enablement gated on the compute API', () => {
    const { host } = landingZone('prod');
    const synth = Testing.synth(host);
    const json = JSON.parse(synth);
    expect(json.provider.google).toEqual([
      { project: 'cdkm-net-prod-host', region: 'us-central1' },
      { alias: 'euw4', project: 'cdkm-net-prod-host', region: 'europe-west4' },
    ]);
    expect(synth).toHaveResourceWithProperties(ComputeNetwork, { name: 'cdkm-net-prod-vpc', auto_create_subnetworks: false, routing_mode: 'GLOBAL' });
    expect(synth).toHaveResourceWithProperties(ComputeSubnetwork, { name: 'cdkm-net-prod-vpc-euw4', region: 'europe-west4', provider: 'google.euw4', ip_cidr_range: '10.31.0.0/20', secondary_ip_range: [{ range_name: 'pods', ip_cidr_range: '10.131.0.0/16' }] });
    expect(synth).toHaveResourceWithProperties(ComputeSubnetwork, { name: 'cdkm-net-prod-vpc-usc1', region: 'us-central1', private_ip_google_access: true });
    // Passing the un-aliased provider object renders an explicit `provider = google` (harmless, and reviewable).
    expect(json.resource.google_compute_subnetwork[Object.keys(json.resource.google_compute_subnetwork).find((k) => k.includes('USC1'))!].provider).toBe('google');
    expect(Object.keys(json.resource.google_compute_router_nat)).toHaveLength(2);
    expect(synth).toHaveResourceWithProperties(ComputeRouterNat, { provider: 'google.euw4', source_subnetwork_ip_ranges_to_nat: 'LIST_OF_SUBNETWORKS' });
    expect(synth).toHaveResourceWithProperties(ComputeSharedVpcHostProject, { project: 'cdkm-net-prod-host', depends_on: [expect.stringContaining('google_project_service.')] });
    // folder id is a cross-stack reference into m09-folders
    expect(json.resource.google_project[Object.keys(json.resource.google_project)[0]].folder_id).toMatch(/^\$\{data\.terraform_remote_state\.cross-stack-reference-input-m09-folders\.outputs\./);
    expect(Object.keys(json.data.terraform_remote_state)).toEqual(['cross-stack-reference-input-m09-folders']);
  });

  test('dev host: one region, single un-aliased provider', () => {
    const { host } = landingZone('dev');
    const json = JSON.parse(Testing.synth(host));
    expect(json.provider.google).toEqual([{ project: 'cdkm-net-dev-host', region: 'us-central1' }]);
    expect(Object.keys(json.resource.google_compute_subnetwork)).toHaveLength(1);
    expect(NETWORK_LAYOUT.dev).toHaveLength(1);
  });

  test('regionalProviders: exactly one un-aliased provider', () => {
    const stack = new TerraformStack(Testing.app(), 'rp');
    const providers = regionalProviders(stack, { project: 'p', regions: ['us-central1', 'europe-west4', 'asia-east1'], defaultRegion: 'europe-west4' });
    expect(providers['europe-west4'].alias).toBeUndefined();
    expect(providers['us-central1'].alias).toBe('usc1');
    expect(providers['asia-east1'].alias).toBe('ase1');
  });
});

describe('09 · service project stack', () => {
  test('attaches to the host, grants subnet-level networkUser to beta-materialised service agents, consumes two remote states', () => {
    const { service } = landingZone('prod');
    const synth = Testing.synth(service);
    const json = JSON.parse(synth);

    expect(synth).toHaveProviderWithProperties(GoogleProvider, { project: 'cdkm-orders-prod-svc', region: 'us-central1' });
    expect(synth).toHaveProvider(GoogleBetaProvider);
    expect(synth).toHaveResourceWithProperties(GoogleProjectServiceIdentity, { service: 'run.googleapis.com', provider: expect.stringMatching(/^google-beta/) });
    expect(synth).toHaveResourceWithProperties(GoogleProjectServiceIdentity, { service: 'sqladmin.googleapis.com' });
    expect(synth).toHaveResourceWithProperties(ComputeSharedVpcServiceProject, {
      // path ServiceProject/Project collapses to ServiceProject_<hash>: cdktf drops a component the previous one ends with (removeDupes in cdktf/lib/private/unique.js)
      service_project: expect.stringMatching(/^\$\{google_project\.ServiceProject_[0-9A-F]{8}\.project_id\}$/),
      host_project: expect.stringMatching(/^\$\{data\.terraform_remote_state\.cross-stack-reference-input-m09-prod-host\.outputs\./),
      deletion_policy: 'ABANDON',
    });
    // 2 subnets × 2 agents
    const grants = Object.values<{ role: string; member: string; subnetwork: string; region: string; project: string }>(json.resource.google_compute_subnetwork_iam_member);
    expect(grants).toHaveLength(4);
    expect(grants.every((g) => g.role === 'roles/compute.networkUser')).toBe(true);
    expect(grants.every((g) => g.subnetwork.startsWith('${data.terraform_remote_state.cross-stack-reference-input-m09-prod-host.outputs.'))).toBe(true);
    expect(grants.every((g) => g.member.startsWith('${google_project_service_identity.'))).toBe(true);
    expect(Object.keys(json.data.terraform_remote_state).sort()).toEqual(['cross-stack-reference-input-m09-folders', 'cross-stack-reference-input-m09-prod-host']);
    // prod: no developer role for the team
    const iam = Object.values<{ role: string }>(json.resource.google_project_iam_member).map((m) => m.role);
    expect(iam).toEqual(['roles/viewer']);
  });

  test('dev service project grants run.developer to the team', () => {
    const { service } = landingZone('dev');
    expect(Testing.synth(service)).toHaveResourceWithProperties(ProjectIamMember, { role: 'roles/run.developer', member: 'group:orders-team@example.com' });
  });

  test('every stack in the landing zone synthesizes fully for dev and prod', () => {
    for (const env of ['dev', 'prod'] as const) {
      const { folders, host, service } = landingZone(env);
      for (const stack of [folders, host, service]) expect(() => Testing.fullSynth(stack)).not.toThrow();
    }
  });

  test('cdktf orders the stacks by their cross-stack dependencies', () => {
    const { folders, host, service } = landingZone('prod');
    expect(host.dependencies).toEqual([folders]);
    expect(service.dependencies).toEqual(expect.arrayContaining([folders, host]));
  });
});

describe('09 · exercise solutions', () => {
  test('1. projectIdFor: deterministic, valid, salted, truncates the service segment', () => {
    const a = projectIdFor({ org: 'cdkm', service: 'orders', env: 'prod' });
    expect(a).toBe(projectIdFor({ org: 'cdkm', service: 'orders', env: 'prod' }));
    expect(a).toMatch(/^cdkm-orders-prod-[0-9a-f]{4}$/);
    expect(projectIdFor({ org: 'cdkm', service: 'orders', env: 'prod', salt: '111' })).not.toBe(a);
    const long = projectIdFor({ org: 'cdkm', service: 'a-very-long-service-name-indeed', env: 'staging' });
    expect(long.length).toBeLessThanOrEqual(30);
    expect(long).toMatch(/^cdkm-.*-staging-[0-9a-f]{4}$/);
    expect(() => validateProjectId(long)).not.toThrow();
  });

  test('2. API bundles resolve, de-duplicate and order through enableApis', () => {
    expect(resolveBundles(['serverless', 'messaging'])).toEqual([...new Set([...API_BUNDLES.serverless, ...API_BUNDLES.messaging])].sort());
    expect(() => resolveBundles(['nope'])).toThrow(/unknown API bundle/);
    const stack = new TerraformStack(Testing.app(), 'bundles');
    new GoogleProvider(stack, 'Google', { project: 'seed' });
    const project = new Project(stack, 'P', { projectId: 'cdkm-x-dev', name: 'x' });
    const apis = new ProjectApis(stack, 'Apis', { project, bundles: ['data', 'observability'], extra: ['cloudresourcemanager.googleapis.com'] });
    const json = JSON.parse(Testing.synth(stack));
    const services = Object.values<{ service: string; depends_on?: string[] }>(json.resource.google_project_service);
    expect(services).toHaveLength(apis.apis.length);
    expect(services.filter((s) => s.service === 'cloudresourcemanager.googleapis.com')[0].depends_on).toBeUndefined();
    expect(services.filter((s) => s.service === 'bigquery.googleapis.com')[0].depends_on).toEqual([expect.stringContaining('google_project_service.')]);
  });

  test('3. service-agent emails and Shared VPC grants per consumer', () => {
    expect(serviceAgentGrants('42', 'cloudrun')[0].member).toBe('serviceAccount:service-42@serverless-robot-prod.iam.gserviceaccount.com');
    expect(serviceAgentGrants('42', 'gke').map((g) => g.member)).toEqual([
      'serviceAccount:service-42@container-engine-robot.iam.gserviceaccount.com',
      'serviceAccount:42@cloudservices.gserviceaccount.com',
    ]);
    expect(serviceAgentGrants('42', 'cloudsql')[0]).toEqual({ member: 'serviceAccount:service-42@gcp-sa-cloud-sql.iam.gserviceaccount.com', subnetRoles: [], hostProjectRoles: ['roles/compute.networkUser'] });

    const stack = new TerraformStack(Testing.app(), 'agents');
    new GoogleProvider(stack, 'Google', { project: 'host' });
    const net = new ComputeNetwork(stack, 'Net', { name: 'n' });
    const subnets = ['us-central1', 'europe-west4'].map((r) => new ComputeSubnetwork(stack, `Subnet${r.replace(/-/g, '')}`, { name: `s-${r}`, region: r, network: net.id, ipCidrRange: '10.0.0.0/24' }));
    const access = new ServiceAgentSubnetAccess(stack, 'Access', { hostProject: 'host', serviceProjectNumber: '42', consumers: ['cloudrun', 'gke', 'composer'], subnets });
    const synth = Testing.synth(stack);
    // cloudrun(1 agent) + gke(2) + composer(2, one shared with gke) = 4 distinct agents × 2 subnets
    expect(access.subnetGrants).toHaveLength(8);
    expect(synth).toHaveResourceWithProperties(ComputeSubnetworkIamMember, { member: 'serviceAccount:service-42@serverless-robot-prod.iam.gserviceaccount.com', role: 'roles/compute.networkUser', region: '${google_compute_subnetwork.Subneteuropewest4.region}', project: 'host' });
    // host-project roles de-duplicated: vpcaccess.user, container.hostServiceAgentUser, composer.sharedVpcAgent
    expect(access.hostGrants.map((g) => g.roleInput).sort()).toEqual(['roles/composer.sharedVpcAgent', 'roles/container.hostServiceAgentUser', 'roles/vpcaccess.user']);
    expect(() => Testing.fullSynth(stack)).not.toThrow();
  });
});

describe('09 · addToApp wiring', () => {
  test('creates folders + host + service per environment with the expected ids', () => {
    // Replicates index.ts against a Testing app so it is exercised without touching cdktf.out.
    const { addToApp } = require('../src/modules/09-multi-project-and-org-scale') as { addToApp: (app: App) => void };
    const app = Testing.app();
    addToApp(app);
    const ids = app.node.findAll().filter((n) => TerraformStack.isStack(n)).map((s) => s.node.id);
    expect(ids).toEqual(['m09-folders', 'm09-dev-host', 'm09-dev-orders', 'm09-prod-host', 'm09-prod-orders']);
  });
});
