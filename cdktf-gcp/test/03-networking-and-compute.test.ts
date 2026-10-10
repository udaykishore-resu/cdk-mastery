import * as fs from 'fs';
import * as path from 'path';
import { App, TerraformOutput, Testing } from 'cdktf';
import { ComputeNetwork } from '@cdktf/provider-google/lib/compute-network';
import { ComputeSubnetwork } from '@cdktf/provider-google/lib/compute-subnetwork';
import { ComputeRouterNat } from '@cdktf/provider-google/lib/compute-router-nat';
import { ComputeFirewall } from '@cdktf/provider-google/lib/compute-firewall';
import { ComputeGlobalAddress } from '@cdktf/provider-google/lib/compute-global-address';
import { ServiceNetworkingConnection } from '@cdktf/provider-google/lib/service-networking-connection';
import { ProjectService } from '@cdktf/provider-google/lib/project-service';
import { SqlDatabaseInstance } from '@cdktf/provider-google/lib/sql-database-instance';
import { SqlUser } from '@cdktf/provider-google/lib/sql-user';
import { SecretManagerSecretVersion } from '@cdktf/provider-google/lib/secret-manager-secret-version';
import { Password } from '@cdktf/provider-random/lib/password';
import { CloudRunV2Service } from '@cdktf/provider-google/lib/cloud-run-v2-service';
import { CloudRunV2ServiceIamMember } from '@cdktf/provider-google/lib/cloud-run-v2-service-iam-member';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { SecretManagerSecretIamMember } from '@cdktf/provider-google/lib/secret-manager-secret-iam-member';
import { ComputeInstance } from '@cdktf/provider-google/lib/compute-instance';
import { VpcAccessConnector } from '@cdktf/provider-google/lib/vpc-access-connector';
import { CloudRunStack, CloudSqlStack, IAP_RANGE, NetworkStack, addToApp } from '../src/modules/03-networking-and-compute';
import { ServerlessConnector, directVpcAccess } from '../src/modules/03-networking-and-compute/solutions/01-vpc-connector';
import { BastionStack } from '../src/modules/03-networking-and-compute/solutions/02-bastion';
import { addReadReplica } from '../src/modules/03-networking-and-compute/solutions/03-read-replica';

Testing.setupJest();

function build(tier: string) {
  const app = Testing.app();
  const network = new NetworkStack(app, 'm03-network', { tier, project: 'proj', region: 'us-central1' });
  const database = new CloudSqlStack(app, 'm03-cloud-sql', { tier, network, project: 'proj' });
  const run = new CloudRunStack(app, 'm03-cloud-run', { tier, network, database, project: 'proj' });
  return { app, network, database, run };
}

describe('03 · NetworkStack', () => {
  const { network } = build('dev');
  const synth = Testing.synth(network);
  const json = JSON.parse(synth);

  it('creates a custom-mode regional VPC that waits for the APIs', () => {
    expect(synth).toHaveResourceWithProperties(ComputeNetwork, {
      name: 'cdkm-net-dev-vpc',
      auto_create_subnetworks: false,
      routing_mode: 'REGIONAL',
      depends_on: expect.arrayContaining([expect.stringMatching(/^google_project_service\.Apis_Compute_[0-9A-F]{8}$/), expect.stringMatching(/^google_project_service\.Apis_Servicenetworking_[0-9A-F]{8}$/)]),
    });
    expect(synth).toHaveResourceWithProperties(ProjectService, { service: 'compute.googleapis.com', disable_on_destroy: false });
  });

  it('subnet has Private Google Access and GKE-ready secondary ranges; flow logs only in HA tiers', () => {
    expect(synth).toHaveResourceWithProperties(ComputeSubnetwork, {
      ip_cidr_range: '10.10.0.0/24',
      private_ip_google_access: true,
      secondary_ip_range: [
        { range_name: 'pods', ip_cidr_range: '10.16.0.0/14' },
        { range_name: 'services', ip_cidr_range: '10.20.0.0/20' },
      ],
    });
    expect(json.resource.google_compute_subnetwork.Workloads.log_config).toBeUndefined();
    const prod = JSON.parse(Testing.synth(build('prod').network));
    expect(prod.resource.google_compute_subnetwork.Workloads.log_config).toEqual({
      aggregation_interval: 'INTERVAL_5_MIN',
      flow_sampling: 0.5,
      metadata: 'INCLUDE_ALL_METADATA',
    });
  });

  it('Cloud NAT uses auto IPs, dynamic port allocation and error logging', () => {
    expect(synth).toHaveResourceWithProperties(ComputeRouterNat, {
      nat_ip_allocate_option: 'AUTO_ONLY',
      source_subnetwork_ip_ranges_to_nat: 'ALL_SUBNETWORKS_ALL_IP_RANGES',
      enable_dynamic_port_allocation: true,
      log_config: { enable: true, filter: 'ERRORS_ONLY' },
      router: '${google_compute_router.Router.name}',
    });
  });

  it('SSH is allowed only from the IAP range and only to the ssh-target service account', () => {
    expect(synth).toHaveResourceWithProperties(ComputeFirewall, {
      name: 'cdkm-net-dev-allow-iap-ssh',
      source_ranges: [IAP_RANGE],
      target_service_accounts: ['${google_service_account.SshTarget.email}'],
      allow: [{ protocol: 'tcp', ports: ['22'] }],
    });
    const iap = json.resource.google_compute_firewall.AllowIapSsh;
    expect(iap.target_tags).toBeUndefined();
    expect(json.resource.google_compute_firewall.AllowInternal.source_ranges).toEqual(['10.10.0.0/24', '10.16.0.0/14', '10.20.0.0/20']);
  });

  it('Private Service Access reserves a /16 and peers it with servicenetworking', () => {
    expect(synth).toHaveResourceWithProperties(ComputeGlobalAddress, { purpose: 'VPC_PEERING', address_type: 'INTERNAL', prefix_length: 16 });
    expect(synth).toHaveResourceWithProperties(ServiceNetworkingConnection, {
      service: 'servicenetworking.googleapis.com',
      reserved_peering_ranges: ['${google_compute_global_address.PrivateServiceRange.name}'],
      deletion_policy: 'ABANDON',
    });
  });
});

describe('03 · CloudSqlStack', () => {
  const dev = build('dev');
  const prod = build('prod');
  const devSynth = Testing.synth(dev.database);
  const prodSynth = Testing.synth(prod.database);
  const devJson = JSON.parse(devSynth);
  const prodJson = JSON.parse(prodSynth);

  it('is private-IP only, on the network stack VPC, with SSL required', () => {
    expect(devJson.resource.google_sql_database_instance.Postgres.settings.ip_configuration).toEqual({
      ipv4_enabled: false,
      private_network: '${google_compute_network.Vpc.id}',
      enable_private_path_for_google_cloud_services: true,
      ssl_mode: 'ENCRYPTED_ONLY',
    });
  });

  it('deletion protection, HA, machine tier and backup retention follow the tier', () => {
    expect(devSynth).toHaveResourceWithProperties(SqlDatabaseInstance, {
      database_version: 'POSTGRES_16',
      deletion_protection: false,
      settings: expect.objectContaining({ tier: 'db-f1-micro', availability_type: 'ZONAL', deletion_protection_enabled: false }),
    });
    expect(prodSynth).toHaveResourceWithProperties(SqlDatabaseInstance, {
      deletion_protection: true,
      settings: expect.objectContaining({ tier: 'db-custom-2-7680', availability_type: 'REGIONAL', deletion_protection_enabled: true }),
    });
    expect(prodJson.resource.google_sql_database_instance.Postgres.settings.backup_configuration).toEqual({
      enabled: true,
      start_time: '03:00',
      point_in_time_recovery_enabled: true,
      transaction_log_retention_days: 7,
      backup_retention_settings: { retained_backups: 30, retention_unit: 'COUNT' },
      location: 'us',
    });
  });

  it('generates the password with the random provider and stores it in Secret Manager and the SQL user', () => {
    expect(devSynth).toHaveResourceWithProperties(Password, { length: 32, special: true, min_special: 2 });
    expect(devSynth).toHaveResourceWithProperties(SqlUser, { name: 'app', password: '${random_password.AppPassword.result}' });
    expect(devSynth).toHaveResourceWithProperties(SecretManagerSecretVersion, {
      secret: '${google_secret_manager_secret.PasswordSecret.id}',
      secret_data: '${random_password.AppPassword.result}',
    });
    expect(devJson.resource.google_sql_database.AppDatabase.deletion_policy).toBe('DELETE');
    expect(prodJson.resource.google_sql_database.AppDatabase.deletion_policy).toBe('ABANDON');
  });
});

describe('03 · CloudRunStack', () => {
  const dev = build('dev');
  const synth = Testing.synth(dev.run);
  const json = JSON.parse(synth);
  const template = json.resource.google_cloud_run_v2_service.Api.template;

  it('runs as its own service account with direct VPC egress into the workload subnet', () => {
    expect(template.service_account).toBe('${google_service_account.RuntimeIdentity.email}');
    expect(template.vpc_access).toEqual({
      egress: 'PRIVATE_RANGES_ONLY',
      network_interfaces: [{ network: '${google_compute_network.Vpc.id}', subnetwork: '${google_compute_subnetwork.Workloads.id}', tags: ['cloud-run'] }],
    });
  });

  it('reads the DB password from Secret Manager rather than an env literal; scaling follows the tier', () => {
    const env = template.containers[0].env;
    expect(env).toContainEqual({
      name: 'DB_PASSWORD',
      value_source: { secret_key_ref: { secret: '${google_secret_manager_secret.PasswordSecret.secret_id}', version: 'latest' } },
    });
    expect(env).toContainEqual({ name: 'DB_HOST', value: '${google_sql_database_instance.Postgres.private_ip_address}' });
    expect(template.scaling).toEqual({ min_instance_count: 0, max_instance_count: 3 });
    expect(JSON.parse(Testing.synth(build('prod').run)).resource.google_cloud_run_v2_service.Api.template.scaling).toEqual({
      min_instance_count: 1,
      max_instance_count: 20,
    });
  });

  it('grants cloudsql.client at project level and secretAccessor on exactly one secret, both additive', () => {
    expect(synth).toHaveResourceWithProperties(ProjectIamMember, {
      role: 'roles/cloudsql.client',
      member: '${google_service_account.RuntimeIdentity.member}',
    });
    expect(synth).toHaveResourceWithProperties(SecretManagerSecretIamMember, {
      role: 'roles/secretmanager.secretAccessor',
      secret_id: '${google_secret_manager_secret.PasswordSecret.secret_id}',
    });
    expect(json.resource.google_project_iam_binding).toBeUndefined();
    expect(json.resource.google_project_iam_policy).toBeUndefined();
  });

  it('dev is public via allUsers; prod has no invoker unless principals are given', () => {
    expect(synth).toHaveResourceWithProperties(CloudRunV2ServiceIamMember, { role: 'roles/run.invoker', member: 'allUsers' });
    const prod = JSON.parse(Testing.synth(build('prod').run));
    expect(prod.resource.google_cloud_run_v2_service_iam_member).toBeUndefined();
    const app = Testing.app();
    const n = new NetworkStack(app, 'n', { tier: 'prod' });
    const d = new CloudSqlStack(app, 'd', { tier: 'prod', network: n });
    const r = new CloudRunStack(app, 'r', { tier: 'prod', network: n, database: d, invokers: ['group:api-clients@example.com'] });
    expect(Testing.synth(r)).toHaveResourceWithProperties(CloudRunV2ServiceIamMember, { member: 'group:api-clients@example.com' });
  });

  it('deletion_protection is tier-driven (the provider default would block destroy)', () => {
    expect(synth).toHaveResourceWithProperties(CloudRunV2Service, { deletion_protection: false, ingress: 'INGRESS_TRAFFIC_ALL' });
    expect(Testing.synth(build('prod').run)).toHaveResourceWithProperties(CloudRunV2Service, { deletion_protection: true });
  });
});

describe('03 · stack wiring', () => {
  it('cross-stack references impose network → sql → run', () => {
    const { network, database, run } = build('dev');
    run.prepareStack();
    database.prepareStack();
    expect(database.dependencies.map((s) => s.node.id)).toEqual(['m03-network']);
    expect(run.dependencies.map((s) => s.node.id).sort()).toEqual(['m03-cloud-sql', 'm03-network']);
    expect(network.dependencies).toEqual([]);
    const runJson = JSON.parse(Testing.synth(run));
    expect(Object.keys(runJson.data.terraform_remote_state).sort()).toEqual([
      'cross-stack-reference-input-m03-cloud-sql',
      'cross-stack-reference-input-m03-network',
    ]);
  });

  it('addToApp registers the three stacks; App.synth writes them all', () => {
    const app = new App({ outdir: fs.mkdtempSync(path.join(require('os').tmpdir(), 'cdktf-m03-')) });
    addToApp(app);
    app.synth();
    const manifest = JSON.parse(fs.readFileSync(path.join(app.outdir, 'manifest.json'), 'utf8'));
    expect(Object.keys(manifest.stacks).sort()).toEqual(['m03-cloud-run', 'm03-cloud-sql', 'm03-network']);
    expect(manifest.stacks['m03-cloud-run'].dependencies.sort()).toEqual(['m03-cloud-sql', 'm03-network']);
    fs.rmSync(app.outdir, { recursive: true, force: true });
  });

  it('full synth of each stack succeeds', () => {
    const { network, database, run } = build('dev');
    for (const s of [network, database, run]) {
      const outdir = Testing.fullSynth(s);
      expect(fs.existsSync(path.join(outdir, 'stacks', s.node.id, 'cdk.tf.json'))).toBe(true);
      fs.rmSync(outdir, { recursive: true, force: true });
    }
  });
});

describe('03 · exercise solutions', () => {
  it('1: a Serverless VPC Access connector on its own /28, and the two vpcAccess shapes', () => {
    const { network } = build('dev');
    const c = new ServerlessConnector(network, 'Connector', { tier: 'dev', region: 'us-central1', networkId: network.network.id, cidr: '10.10.9.0/28' });
    const synth = Testing.synth(network);
    expect(synth).toHaveResourceWithProperties(VpcAccessConnector, { machine_type: 'e2-micro', min_instances: 2, max_instances: 3 });
    // Every attribute access mints a new token, so `c.connector.id !== c.connector.id`; compare resolved values.
    // (Note the logical id: makeUniqueId de-duplicates consecutive path parts, so Connector/Connector -> Connector_<hash>.)
    new TerraformOutput(network, 'connector_block', { value: c.vpcAccess() });
    expect(JSON.parse(Testing.synth(network)).output.connector_block.value).toEqual({
      connector: expect.stringMatching(/^\$\{google_vpc_access_connector\.Connector_[0-9A-F]{8}\.id\}$/),
      egress: 'PRIVATE_RANGES_ONLY',
    });
    expect(directVpcAccess('net', 'sub', ['t'])).toEqual({ egress: 'PRIVATE_RANGES_ONLY', networkInterfaces: [{ network: 'net', subnetwork: 'sub', tags: ['t'] }] });
    expect(() => new ServerlessConnector(network, 'Bad', { tier: 'dev', region: 'us-central1', networkId: 'n', cidr: '10.0.0.0/24' })).toThrow(/\/28/);
  });

  it('2: the bastion has no external IP, is shielded, uses OS Login and the ssh-target identity', () => {
    const { app, network } = build('dev');
    const bastion = new BastionStack(app, 'm03-bastion', { tier: 'dev', network, project: 'proj', operators: ['group:sre@example.com'] });
    const synth = Testing.synth(bastion);
    expect(synth).toHaveResourceWithProperties(ComputeInstance, {
      machine_type: 'e2-micro',
      network_interface: [{ subnetwork: '${google_compute_subnetwork.Workloads.id}' }],
      service_account: { email: '${google_service_account.SshTarget.email}', scopes: ['https://www.googleapis.com/auth/cloud-platform'] },
      shielded_instance_config: { enable_secure_boot: true, enable_vtpm: true, enable_integrity_monitoring: true },
      metadata: { 'enable-oslogin': 'TRUE', 'block-project-ssh-keys': 'TRUE' },
    });
    expect(JSON.stringify(JSON.parse(synth).resource.google_compute_instance)).not.toContain('access_config');
    expect(synth).toHaveResourceWithProperties(ProjectIamMember, { role: 'roles/iap.tunnelResourceAccessor', member: 'group:sre@example.com' });
  });

  it('3: a read replica exists only for HA tiers and never carries its own backups', () => {
    const dev = build('dev');
    expect(addReadReplica(dev.database, 'Replica', { tier: 'dev', primary: dev.database.instance, region: 'us-east1', networkId: 'net' })).toBeUndefined();
    const prod = build('prod');
    const replica = addReadReplica(prod.database, 'Replica', { tier: 'prod', primary: prod.database.instance, region: 'us-east1', networkId: prod.network.network.id });
    expect(replica).toBeDefined();
    const json = JSON.parse(Testing.synth(prod.database));
    expect(json.resource.google_sql_database_instance.Replica).toMatchObject({
      master_instance_name: '${google_sql_database_instance.Postgres.name}',
      region: 'us-east1',
      deletion_protection: true,
      settings: expect.objectContaining({ availability_type: 'ZONAL', ip_configuration: expect.objectContaining({ ipv4_enabled: false }) }),
    });
    expect(json.resource.google_sql_database_instance.Replica.settings.backup_configuration).toBeUndefined();
  });
});
