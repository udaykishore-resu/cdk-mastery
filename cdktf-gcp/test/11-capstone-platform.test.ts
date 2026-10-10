import { App, TerraformStack, Testing } from 'cdktf';
import { BillingBudget } from '@cdktf/provider-google/lib/billing-budget';
import { CloudRunV2Service } from '@cdktf/provider-google/lib/cloud-run-v2-service';
import { CloudSchedulerJob } from '@cdktf/provider-google/lib/cloud-scheduler-job';
import { Cloudfunctions2Function } from '@cdktf/provider-google/lib/cloudfunctions2-function';
import { ComputeRouterNat } from '@cdktf/provider-google/lib/compute-router-nat';
import { ComputeNetwork } from '@cdktf/provider-google/lib/compute-network';
import { IamWorkloadIdentityPoolProvider } from '@cdktf/provider-google/lib/iam-workload-identity-pool-provider';
import { MonitoringAlertPolicy } from '@cdktf/provider-google/lib/monitoring-alert-policy';
import { MonitoringUptimeCheckConfig } from '@cdktf/provider-google/lib/monitoring-uptime-check-config';
import { PubsubSubscription } from '@cdktf/provider-google/lib/pubsub-subscription';
import { ServiceAccountIamMember } from '@cdktf/provider-google/lib/service-account-iam-member';
import { ServiceNetworkingConnection } from '@cdktf/provider-google/lib/service-networking-connection';
import { SqlDatabaseInstance } from '@cdktf/provider-google/lib/sql-database-instance';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { ENVIRONMENTS, EnvironmentName, mandatoryTags } from '@cdk-mastery/shared';
import { OrdersPlatform, TIER_SETTINGS } from '../src/modules/11-capstone-platform';
import { isLabelledResource } from '../src/modules/06-aspects-labels-and-governance/labels-aspect';
import { stabilise } from '../src/modules/07-testing/snapshot-stabiliser';
import { costTable, estimateMonthlyCost } from '../src/modules/11-capstone-platform/solutions/cost-estimate';
import { DeadLetterArchive } from '../src/modules/11-capstone-platform/solutions/dead-letter-archive';
import { addReadReplica } from '../src/modules/11-capstone-platform/solutions/read-replica';

Testing.setupJest();

const FIXED = { project: 'orders-demo', region: 'us-central1', github: { owner: 'example-org', repo: 'cdk-mastery' }, billingAccount: 'AAAAAA-BBBBBB-CCCCCC', alertEmail: 'oncall@example.com', assetHash: 'PINNED' };

/** Build one environment; prepare every stack so cross-stack references resolve. */
function platform(env: EnvironmentName) {
  const app = Testing.app();
  const p = new OrdersPlatform(app, { tier: ENVIRONMENTS[env], ...FIXED });
  for (const stack of p.deployOrder) stack.prepareStack();
  return { app, p };
}

/** Parsed JSON per stack id. */
function synthAll(p: OrdersPlatform): Record<string, any> {
  return Object.fromEntries(p.deployOrder.map((s) => [s.node.id, JSON.parse(Testing.synth(s))]));
}

const errorsIn = (stack: TerraformStack) => stack.node.findAll().flatMap((n) => n.node.metadata.filter((m) => m.type === '@cdktf/error').map((m) => `[${n.node.path}] ${m.data}`));

describe('11 · every stack synthesizes for dev and prod', () => {
  for (const env of ['dev', 'prod'] as const) {
    test(`${env}: six stacks, correct ids, fullSynth clean, no governance errors`, () => {
      const { p } = platform(env);
      expect(p.stackIds).toEqual(['foundation', 'network', 'data', 'messaging', 'compute', 'observability'].map((c) => `m11-${env}-${c}`));
      for (const stack of p.deployOrder) {
        expect(() => Testing.fullSynth(stack)).not.toThrow();
        expect(errorsIn(stack)).toEqual([]);
      }
    });
  }

  test('addToApp creates twelve stacks', () => {
    const { addToApp } = require('../src/modules/11-capstone-platform') as { addToApp: (app: App) => void };
    const app = Testing.app();
    addToApp(app);
    const ids = app.node.findAll().filter((n) => TerraformStack.isStack(n)).map((s) => s.node.id);
    expect(ids).toHaveLength(12);
    expect(ids.filter((i) => i.startsWith('m11-prod-'))).toHaveLength(6);
  });

  test('deploy order follows the cross-stack dependencies', () => {
    const { p } = platform('prod');
    expect(p.data.dependencies).toEqual(expect.arrayContaining([p.foundation, p.network]));
    expect(p.compute.dependencies).toEqual(expect.arrayContaining([p.foundation, p.network, p.data, p.messaging]));
    expect(p.observability.dependencies).toEqual(expect.arrayContaining([p.compute, p.messaging]));
    expect(p.foundation.dependencies).toEqual([]);
  });
});

describe('11 · per-tier assertions', () => {
  const dev = synthAll(platform('dev').p);
  const prod = synthAll(platform('prod').p);

  test('prod has deletion protection and CMEK on Cloud SQL; dev has neither', () => {
    const pg = (j: Record<string, any>, env: string) => j[`m11-${env}-data`].resource.google_sql_database_instance.Postgres;
    expect(pg(prod, 'prod')).toMatchObject({ deletion_protection: true, encryption_key_name: expect.stringContaining('cross-stack-reference-input-m11-prod-foundation'), settings: expect.objectContaining({ deletion_protection_enabled: true, availability_type: 'REGIONAL', tier: 'db-custom-2-7680' }) });
    expect(pg(prod, 'prod').settings.backup_configuration.point_in_time_recovery_enabled).toBe(true);
    expect(pg(dev, 'dev')).toMatchObject({ deletion_protection: false, settings: expect.objectContaining({ deletion_protection_enabled: false, availability_type: 'ZONAL', tier: 'db-f1-micro' }) });
    expect(pg(dev, 'dev').encryption_key_name).toBeUndefined();
    expect(pg(dev, 'dev').settings.ip_configuration).toMatchObject({ ipv4_enabled: false, private_network: expect.stringContaining('cross-stack-reference-input-m11-dev-network') });
  });

  test('prod buckets use CMEK and prevent_destroy; dev buckets are force-destroyable', () => {
    const prodBucket = prod['m11-prod-compute'].resource.google_storage_bucket.FunctionSource;
    expect(prodBucket.encryption.default_kms_key_name).toContain('cross-stack-reference-input-m11-prod-foundation');
    expect(prodBucket.lifecycle).toEqual({ prevent_destroy: true });
    expect(prodBucket.force_destroy).toBe(false);
    expect(prodBucket.public_access_prevention).toBe('enforced');
    const devBucket = dev['m11-dev-compute'].resource.google_storage_bucket.FunctionSource;
    expect(devBucket.encryption).toBeUndefined();
    expect(devBucket.force_destroy).toBe(true);
    expect(devBucket.lifecycle).toEqual({ prevent_destroy: false });
  });

  test('prod has an uptime check + down alert; dev does not', () => {
    expect(prod['m11-prod-observability'].resource.google_monitoring_uptime_check_config.ApiUptime).toMatchObject({
      http_check: { path: '/healthz', port: 443, use_ssl: true, validate_ssl: true },
      monitored_resource: { type: 'uptime_url', labels: { project_id: 'orders-demo', host: expect.stringMatching(/^\$\{replace\(.*"https:\/\/", ""\)\}$/) } },
    });
    expect(Object.keys(prod['m11-prod-observability'].resource.google_monitoring_alert_policy).sort()).toEqual(['ApiDown', 'ApiErrors', 'DeadLetterDepth']);
    expect(dev['m11-dev-observability'].resource.google_monitoring_uptime_check_config).toBeUndefined();
    expect(Object.keys(dev['m11-dev-observability'].resource.google_monitoring_alert_policy).sort()).toEqual(['ApiErrors', 'DeadLetterDepth']);
  });

  test('Cloud Run: min instances, ingress, VPC egress and secret env per tier', () => {
    const api = (j: Record<string, any>, env: string) => j[`m11-${env}-compute`].resource.google_cloud_run_v2_service.Api;
    expect(api(prod, 'prod').template.scaling).toEqual({ min_instance_count: 1, max_instance_count: 20 });
    expect(api(dev, 'dev').template.scaling).toEqual({ min_instance_count: 0, max_instance_count: 3 });
    expect(api(prod, 'prod').ingress).toBe('INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER');
    expect(api(prod, 'prod').template.vpc_access.egress).toBe('PRIVATE_RANGES_ONLY');
    expect(api(prod, 'prod').template.vpc_access.network_interfaces[0].subnetwork).toContain('cross-stack-reference-input-m11-prod-network');
    const env = api(prod, 'prod').template.containers[0].env as Array<{ name: string; value?: string; value_source?: unknown }>;
    expect(env.find((e) => e.name === 'DB_PASSWORD')).toEqual({ name: 'DB_PASSWORD', value_source: { secret_key_ref: { secret: expect.stringContaining('cross-stack-reference-input-m11-prod-data'), version: 'latest' } } });
    expect(api(prod, 'prod').deletion_protection).toBe(true);
    expect(api(dev, 'dev').deletion_protection).toBe(false);
  });

  test('WIF: prod deployer bound to the GitHub environment, dev deployer to the repository', () => {
    const member = (j: Record<string, any>, env: string) => j[`m11-${env}-foundation`].resource.google_service_account_iam_member.DeployerWorkloadIdentityUser.member as string;
    expect(member(prod, 'prod')).toMatch(/\/attribute\.environment\/prod$/);
    expect(member(dev, 'dev')).toMatch(/\/attribute\.repository\/example-org\/cdk-mastery$/);
    expect(Testing.synth(platform('prod').p.foundation)).toHaveResourceWithProperties(IamWorkloadIdentityPoolProvider, {
      attribute_condition: 'attribute.repository == "example-org/cdk-mastery"',
      attribute_mapping: expect.objectContaining({ 'attribute.environment': 'assertion.environment' }),
    });
    expect(prod['m11-prod-foundation'].resource.google_service_account_key).toBeUndefined();
  });

  test('budgets and alert thresholds follow TIER_SETTINGS and the tier', () => {
    expect(prod['m11-prod-observability'].resource.google_billing_budget.Budget.amount.specified_amount.units).toBe(String(TIER_SETTINGS.prod.monthlyBudgetUsd));
    expect(dev['m11-dev-observability'].resource.google_billing_budget.Budget.amount.specified_amount.units).toBe(String(TIER_SETTINGS.dev.monthlyBudgetUsd));
    expect(prod['m11-prod-observability'].resource.google_monitoring_alert_policy.ApiErrors.severity).toBe('CRITICAL');
    expect(dev['m11-dev-observability'].resource.google_monitoring_alert_policy.ApiErrors.severity).toBe('WARNING');
    expect(prod['m11-prod-compute'].resource.google_cloud_scheduler_job.Reconcile.schedule).toBe('*/15 * * * *');
    expect(dev['m11-dev-compute'].resource.google_cloud_scheduler_job.Reconcile.schedule).toBe('0 * * * *');
  });
});

describe('11 · governance applied per stack', () => {
  test('every resource that accepts labels carries the mandatory labels, in every stack, both tiers', () => {
    for (const env of ['dev', 'prod'] as const) {
      const { p } = platform(env);
      const expected = mandatoryTags(ENVIRONMENTS[env], 'orders');
      let checked = 0;
      for (const stack of p.deployOrder) {
        Testing.synth(stack); // runs the aspects
        for (const node of stack.node.findAll()) {
          if (!isLabelledResource(node)) continue;
          checked++;
          expect({ path: node.node.path, labels: node.labelsInput }).toEqual({ path: node.node.path, labels: expect.objectContaining(expected) });
        }
      }
      expect(checked).toBeGreaterThan(10);
    }
  });

  test('Cloud SQL user_labels and alert user_labels are set explicitly (the aspect cannot reach them)', () => {
    const j = synthAll(platform('prod').p);
    expect(j['m11-prod-data'].resource.google_sql_database_instance.Postgres.settings.user_labels).toMatchObject({ environment: 'prod', service: 'orders' });
    expect(j['m11-prod-observability'].resource.google_monitoring_alert_policy.ApiErrors.user_labels).toMatchObject({ environment: 'prod' });
  });

  test('construct ids are PascalCase everywhere the author chose them (framework ids exempt)', () => {
    const { p } = platform('prod');
    for (const stack of p.deployOrder) {
      Testing.synth(stack);
      expect(errorsIn(stack).filter((e) => e.includes('pascal-case'))).toEqual([]);
    }
  });

  test('a public bucket or a missing prod CMEK would abort synthesis (the aspects are live)', () => {
    const { p } = platform('prod');
    new StorageBucket(p.compute, 'Rogue', { name: 'rogue', location: 'US' }); // no PAP, no CMEK
    expect(() => Testing.fullSynth(p.compute)).toThrow(/Rogue.*publicAccessPrevention[\s\S]*Rogue.*customer-managed key/);
  });

  test('backend is local by default and GCS when configured', () => {
    const { p } = platform('dev');
    expect(JSON.parse(Testing.synth(p.network)).terraform.backend.local).toBeDefined();
    const gcs = new OrdersPlatform(Testing.app(), { tier: ENVIRONMENTS.dev, ...FIXED, backend: (id) => ({ kind: 'gcs', bucket: 'tf-state', prefix: `cdk-mastery/${id}` }) });
    expect(JSON.parse(Testing.synth(gcs.network)).terraform.backend).toEqual({ gcs: { bucket: 'tf-state', prefix: 'cdk-mastery/m11-dev-network' } });
  });
});

describe('11 · wiring details worth pinning', () => {
  const j = synthAll(platform('prod').p);

  test('network: custom VPC, NAT, PSA range + peering with ABANDON', () => {
    const net = j['m11-prod-network'];
    expect(Testing.synth(platform('prod').p.network)).toHaveResourceWithProperties(ComputeNetwork, { auto_create_subnetworks: false });
    expect(Testing.synth(platform('prod').p.network)).toHaveResourceWithProperties(ComputeRouterNat, { nat_ip_allocate_option: 'AUTO_ONLY' });
    expect(net.resource.google_compute_global_address.PsaRange).toMatchObject({ purpose: 'VPC_PEERING', address_type: 'INTERNAL', prefix_length: 16 });
    expect(Testing.synth(platform('prod').p.network)).toHaveResourceWithProperties(ServiceNetworkingConnection, { service: 'servicenetworking.googleapis.com', deletion_policy: 'ABANDON' });
  });

  test('messaging: DLQ policy, a subscription on the DLQ, and the service-agent grants', () => {
    const m = j['m11-prod-messaging'].resource;
    expect(m.google_pubsub_subscription.OrdersPull.dead_letter_policy).toEqual({ dead_letter_topic: '${google_pubsub_topic.OrdersDlq.id}', max_delivery_attempts: 5 });
    expect(m.google_pubsub_subscription.OrdersDlqPull.topic).toBe('${google_pubsub_topic.OrdersDlq.name}');
    expect(m.google_pubsub_topic_iam_member.DlqPublisher.role).toBe('roles/pubsub.publisher');
    expect(m.google_pubsub_subscription_iam_member.SourceSubscriber.role).toBe('roles/pubsub.subscriber');
    expect(m.google_pubsub_topic_iam_member.DlqPublisher.member).toMatch(/^serviceAccount:service-\$\{data\.google_project\.Current\.number\}@gcp-sa-pubsub/);
  });

  test('compute: function from the asset, triggered by the topic, with its own SA; scheduler with OIDC', () => {
    const c = j['m11-prod-compute'].resource;
    expect(c.google_storage_bucket_object.WorkerSourceObject).toMatchObject({ name: 'worker/PINNED.zip', source: 'assets/WorkerSource/PINNED/archive.zip' });
    expect(c.google_cloudfunctions2_function.Worker).toMatchObject({
      build_config: { runtime: 'nodejs20', entry_point: 'handleOrder', source: { storage_source: { bucket: '${google_storage_bucket.FunctionSource.name}', object: '${google_storage_bucket_object.WorkerSourceObject.name}' } } },
      event_trigger: { event_type: 'google.cloud.pubsub.topic.v1.messagePublished', retry_policy: 'RETRY_POLICY_RETRY', pubsub_topic: expect.stringContaining('cross-stack-reference-input-m11-prod-messaging') },
      service_config: { service_account_email: '${google_service_account.WorkerAccount.email}', ingress_settings: 'ALLOW_INTERNAL_ONLY' },
    });
    expect(c.google_cloud_scheduler_job.Reconcile.http_target).toMatchObject({ http_method: 'POST', oidc_token: { service_account_email: '${google_service_account.SchedulerAccount.email}' } });
    expect(c.google_cloud_run_v2_service_iam_member.SchedulerInvokesApi.role).toBe('roles/run.invoker');
    expect(Testing.synth(platform('prod').p.compute)).toHaveResource(Cloudfunctions2Function);
    expect(Testing.synth(platform('prod').p.compute)).toHaveResource(CloudRunV2Service);
    expect(Testing.synth(platform('prod').p.compute)).toHaveResource(CloudSchedulerJob);
  });

  test('observability: 5xx alert filter targets the API service name from the compute stack', () => {
    const o = j['m11-prod-observability'].resource;
    expect(o.google_monitoring_alert_policy.ApiErrors.conditions[0].condition_threshold.filter).toContain('metric.labels.response_code_class = "5xx"');
    expect(o.google_monitoring_alert_policy.ApiErrors.conditions[0].condition_threshold.filter).toContain('cross-stack-reference-input-m11-prod-compute');
    expect(o.google_monitoring_alert_policy.DeadLetterDepth.conditions[0].condition_threshold.filter).toContain('num_undelivered_messages');
    expect(Testing.synth(platform('prod').p.observability)).toHaveResource(MonitoringUptimeCheckConfig);
    expect(Testing.synth(platform('prod').p.observability)).toHaveResource(MonitoringAlertPolicy);
    expect(Testing.synth(platform('prod').p.observability)).toHaveResource(BillingBudget);
  });

  test('foundation: APIs gated, key grants for the three service agents', () => {
    const f = j['m11-prod-foundation'].resource;
    expect(f.google_project_service.ApiRunGoogleapisCom.depends_on).toEqual(['google_project_service.ApiCloudresourcemanagerGoogleapisCom']);
    expect(f.google_project_service.ApiServiceusageGoogleapisCom.depends_on).toBeUndefined();
    expect(Object.values<{ disable_on_destroy: boolean }>(f.google_project_service).every((s) => s.disable_on_destroy === false)).toBe(true);
    expect(Object.keys(f.google_kms_crypto_key_iam_member).sort()).toEqual(['KeyUserBigquery', 'KeyUserCloudSql', 'KeyUserStorage']);
  });
});

describe('11 · snapshot of one small stack (messaging, prod)', () => {
  test('stabilised', () => {
    const { p } = platform('prod');
    expect(stabilise(Testing.synth(p.messaging))).toMatchSnapshot();
  });
});

describe('11 · exercise solutions', () => {
  test('1. cost estimate: prod costs more than dev, table renders, budget above estimate', () => {
    const dev = estimateMonthlyCost(ENVIRONMENTS.dev);
    const prod = estimateMonthlyCost(ENVIRONMENTS.prod);
    expect(prod.total).toBeGreaterThan(dev.total * 5);
    expect(TIER_SETTINGS.prod.monthlyBudgetUsd).toBeGreaterThan(prod.total);
    expect(TIER_SETTINGS.dev.monthlyBudgetUsd).toBeGreaterThan(dev.total);
    expect(costTable(ENVIRONMENTS.prod)).toMatch(/\| \*\*Total\*\* \| \*\*\$\d+\*\* \|/);
  });

  test('2. dead-letter archive: BigQuery subscription with metadata, partitioned table, agent grant', () => {
    const { p } = platform('prod');
    const archive = new DeadLetterArchive(p.messaging, 'DlqArchive', {
      deadLetterTopic: p.messaging.deadLetter,
      datasetId: 'orders_analytics',
      projectNumber: '123',
      labels: mandatoryTags(ENVIRONMENTS.prod, 'orders'),
      retainStatefulResources: true,
    });
    const synth = Testing.synth(p.messaging);
    expect(synth).toHaveResourceWithProperties(PubsubSubscription, {
      topic: '${google_pubsub_topic.OrdersDlq.name}',
      bigquery_config: { table: expect.stringMatching(/^\$\{google_bigquery_table\.DlqArchive_Table_[0-9A-F]{8}\.project\}\.\$\{google_bigquery_table\..*\.table_id\}$/), write_metadata: true },
      depends_on: [expect.stringMatching(/^google_bigquery_table_iam_member\./)],
    });
    expect(archive.table.deletionProtectionInput).toBe(true);
    const j = JSON.parse(synth);
    const table = Object.values<any>(j.resource.google_bigquery_table)[0];
    expect(table.time_partitioning).toEqual({ type: 'DAY', field: 'publish_time' });
    expect(JSON.parse(table.schema).map((f: { name: string }) => f.name)).toEqual(['subscription_name', 'message_id', 'publish_time', 'data', 'attributes']);
    expect(errorsIn(p.messaging)).toEqual([]);
  });

  test('3. read replica: prod only, cross-region, private, encrypted, protected', () => {
    const { p } = platform('prod');
    const replica = addReadReplica(p.data, 'Replica', {
      tier: ENVIRONMENTS.prod,
      primary: p.data.instance,
      region: 'us-east1',
      networkId: p.network.network.id,
      encryptionKeyName: 'projects/orders-demo/locations/us-east1/keyRings/r/cryptoKeys/k',
      labels: mandatoryTags(ENVIRONMENTS.prod, 'orders'),
    });
    expect(replica).toBeDefined();
    const synth = Testing.synth(p.data);
    expect(synth).toHaveResourceWithProperties(SqlDatabaseInstance, {
      name: 'cdkm-orders-prod-pg-replica-us-east1',
      region: 'us-east1',
      master_instance_name: '${google_sql_database_instance.Postgres.name}',
      replica_configuration: { failover_target: false },
      deletion_protection: true,
      encryption_key_name: 'projects/orders-demo/locations/us-east1/keyRings/r/cryptoKeys/k',
      settings: expect.objectContaining({ availability_type: 'ZONAL', ip_configuration: expect.objectContaining({ ipv4_enabled: false }) }),
    });
    expect(errorsIn(p.data)).toEqual([]); // CMEK aspect satisfied by the replica's key

    const dev = platform('dev');
    expect(addReadReplica(dev.p.data, 'Replica', { tier: ENVIRONMENTS.dev, primary: dev.p.data.instance, region: 'us-east1', networkId: 'n' })).toBeUndefined();
    expect(() => addReadReplica(p.data, 'SameRegion', { tier: ENVIRONMENTS.prod, primary: p.data.instance, region: 'us-central1', networkId: 'n' })).toThrow(/must differ/);
  });
});

describe('11 · provider sanity', () => {
  test('each stack has exactly one google provider', () => {
    const { p } = platform('prod');
    for (const stack of p.deployOrder) {
      const synth = Testing.synth(stack);
      expect(synth).toHaveProviderWithProperties(GoogleProvider, { project: 'orders-demo', region: 'us-central1' });
      expect(JSON.parse(synth).provider.google).toHaveLength(1);
    }
  });
});
