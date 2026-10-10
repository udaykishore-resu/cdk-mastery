import * as fs from 'fs';
import * as path from 'path';
import { Testing, Token } from 'cdktf';
import { PubsubTopic } from '@cdktf/provider-google/lib/pubsub-topic';
import { PubsubSubscription } from '@cdktf/provider-google/lib/pubsub-subscription';
import { PubsubTopicIamMember } from '@cdktf/provider-google/lib/pubsub-topic-iam-member';
import { PubsubSubscriptionIamMember } from '@cdktf/provider-google/lib/pubsub-subscription-iam-member';
import { PubsubTopicIamBinding } from '@cdktf/provider-google/lib/pubsub-topic-iam-binding';
import { PubsubTopicIamPolicy } from '@cdktf/provider-google/lib/pubsub-topic-iam-policy';
import { Cloudfunctions2Function } from '@cdktf/provider-google/lib/cloudfunctions2-function';
import { StorageBucketObject } from '@cdktf/provider-google/lib/storage-bucket-object';
import { EventarcTrigger } from '@cdktf/provider-google/lib/eventarc-trigger';
import { CloudSchedulerJob } from '@cdktf/provider-google/lib/cloud-scheduler-job';
import { BigqueryDataset } from '@cdktf/provider-google/lib/bigquery-dataset';
import { BigqueryTable } from '@cdktf/provider-google/lib/bigquery-table';
import { BigqueryDatasetIamMember } from '@cdktf/provider-google/lib/bigquery-dataset-iam-member';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { CloudRunV2ServiceIamMember } from '@cdktf/provider-google/lib/cloud-run-v2-service-iam-member';
import { SecretManagerSecretVersion } from '@cdktf/provider-google/lib/secret-manager-secret-version';
import { ServiceAccountIamMember } from '@cdktf/provider-google/lib/service-account-iam-member';
import { MonitoringAlertPolicy } from '@cdktf/provider-google/lib/monitoring-alert-policy';
import { EventsStack, IamTrapStack, ORDER_EVENTS_SCHEMA, addToApp } from '../src/modules/04-serverless-and-events';
import { BigQuerySubscription } from '../src/modules/04-serverless-and-events/solutions/01-bigquery-subscription';
import { PushSubscription } from '../src/modules/04-serverless-and-events/solutions/02-push-subscription';
import { DeadLetterAlert } from '../src/modules/04-serverless-and-events/solutions/03-dlq-alert';
import { ENVIRONMENTS } from '@cdk-mastery/shared';

Testing.setupJest();

const PUBSUB_AGENT = 'serviceAccount:service-${data.google_project.Project.number}@gcp-sa-pubsub.iam.gserviceaccount.com';

describe('04 · Pub/Sub', () => {
  const stack = new EventsStack(Testing.app(), 'm04-events', { tier: 'dev', project: 'proj', region: 'us-central1' });
  const synth = Testing.synth(stack);

  it('topic and dead-letter topic retain messages for 7 days', () => {
    expect(synth).toHaveResourceWithProperties(PubsubTopic, { name: 'cdkm-events-dev-orders', message_retention_duration: '604800s' });
    expect(synth).toHaveResourceWithProperties(PubsubTopic, { name: 'cdkm-events-dev-orders-dead-letter' });
  });

  it('worker subscription: ack deadline, retry backoff, DLQ after 5 attempts, filter, ordering, never expires', () => {
    expect(synth).toHaveResourceWithProperties(PubsubSubscription, {
      name: 'cdkm-events-dev-orders-worker',
      ack_deadline_seconds: 60,
      retry_policy: { minimum_backoff: '10s', maximum_backoff: '600s' },
      dead_letter_policy: { dead_letter_topic: expect.stringMatching(/^\$\{google_pubsub_topic\.Orders_DeadLetterTopic_[0-9A-F]{8}\.id\}$/), max_delivery_attempts: 5 },
      filter: 'attributes.type = "order.created"',
      enable_message_ordering: true,
      expiration_policy: { ttl: '' },
    });
    expect(synth).toHaveResourceWithProperties(PubsubSubscription, { name: 'cdkm-events-dev-orders-dead-letter-monitor', ack_deadline_seconds: 600 });
  });

  it('grants the Pub/Sub service agent publisher on the DLQ and subscriber on the source (or dead-lettering silently fails)', () => {
    expect(synth).toHaveResourceWithProperties(PubsubTopicIamMember, { role: 'roles/pubsub.publisher', member: PUBSUB_AGENT });
    expect(synth).toHaveResourceWithProperties(PubsubSubscriptionIamMember, { role: 'roles/pubsub.subscriber', member: PUBSUB_AGENT });
  });
});

describe('04 · Cloud Functions gen2 from a TerraformAsset', () => {
  const stack = new EventsStack(Testing.app(), 'm04-events', { tier: 'dev', project: 'proj', region: 'us-central1' });
  const synth = Testing.synth(stack);
  const json = JSON.parse(synth);

  it('zips the real handler folder and uploads it under a hash-named object', () => {
    expect(fs.existsSync(path.join(__dirname, '..', 'src', 'modules', '04-serverless-and-events', 'functions', 'hello', 'index.js'))).toBe(true);
    expect(synth).toHaveResourceWithProperties(StorageBucketObject, {
      name: expect.stringMatching(/^order-processor-[0-9A-F]{32}\.zip$/),
      source: expect.stringMatching(/^assets\/OrderProcessor_Source_[0-9A-F]{8}\/[0-9A-F]{32}\/archive\.zip$/),
    });
    expect(Token.isUnresolved(stack.processor.asset.assetHash)).toBe(false);
    expect(stack.processor.asset.assetHash).toHaveLength(32);
  });

  it('full synth copies the archive into the stack output directory next to cdk.tf.json', () => {
    const outdir = Testing.fullSynth(stack);
    const obj = JSON.parse(fs.readFileSync(path.join(outdir, 'stacks', 'm04-events', 'cdk.tf.json'), 'utf8')).resource.google_storage_bucket_object;
    const source = (Object.values(obj)[0] as { source: string }).source;
    expect(fs.existsSync(path.join(outdir, 'stacks', 'm04-events', source))).toBe(true);
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  it('builds nodejs22 with the handler entry point and triggers on the topic with retry, as its own service accounts', () => {
    expect(synth).toHaveResourceWithProperties(Cloudfunctions2Function, {
      name: 'cdkm-events-dev-order-processor',
      build_config: expect.objectContaining({ runtime: 'nodejs22', entry_point: 'processOrder' }),
      event_trigger: {
        trigger_region: 'us-central1',
        event_type: 'google.cloud.pubsub.topic.v1.messagePublished',
        pubsub_topic: expect.stringMatching(/^\$\{google_pubsub_topic\.Orders_Topic_[0-9A-F]{8}\.id\}$/),
        retry_policy: 'RETRY_POLICY_RETRY',
        service_account_email: expect.stringMatching(/TriggerAccount/),
      },
      service_config: expect.objectContaining({
        ingress_settings: 'ALLOW_INTERNAL_ONLY',
        service_account_email: expect.stringMatching(/RuntimeAccount/),
        secret_environment_variables: [{ key: 'WEBHOOK_TOKEN', project_id: 'proj', secret: '${google_secret_manager_secret.WebhookSecret.secret_id}', version: 'latest' }],
      }),
    });
    expect(synth).toHaveResourceWithProperties(SecretManagerSecretVersion, { secret_data: '${random_password.WebhookToken.result}' });
  });

  it('runtime SA writes BigQuery; trigger SA receives events and invokes the function', () => {
    expect(synth).toHaveResourceWithProperties(BigqueryDatasetIamMember, { role: 'roles/bigquery.dataEditor', member: expect.stringMatching(/RuntimeAccount.*\.member/) });
    expect(synth).toHaveResourceWithProperties(ProjectIamMember, { role: 'roles/eventarc.eventReceiver', member: expect.stringMatching(/OrderProcessor_TriggerAccount.*\.member/) });
    expect(synth).toHaveResourceWithProperties(CloudRunV2ServiceIamMember, {
      role: 'roles/run.invoker',
      name: expect.stringMatching(/^\$\{google_cloudfunctions2_function\.OrderProcessor_Function_[0-9A-F]{8}\.name\}$/),
    });
    expect(json.resource.google_project_service.ApiPubsub).toEqual({ service: 'pubsub.googleapis.com', disable_on_destroy: false });
  });
});

describe('04 · Eventarc, Scheduler, BigQuery', () => {
  const dev = new EventsStack(Testing.app(), 'm04-events', { tier: 'dev', project: 'proj' });
  const synth = Testing.synth(dev);
  const json = JSON.parse(synth);

  it('GCS finalized → Cloud Run trigger with matching criteria, after the IAM it depends on', () => {
    expect(synth).toHaveResourceWithProperties(EventarcTrigger, {
      matching_criteria: [
        { attribute: 'type', value: 'google.cloud.storage.object.v1.finalized' },
        { attribute: 'bucket', value: expect.stringMatching(/^\$\{google_storage_bucket\.Uploads_[0-9A-F]{8}\.name\}$/) },
      ],
      destination: { cloud_run_service: { service: expect.stringMatching(/Uploads_Handler/), region: 'us-central1', path: '/uploads' } },
      depends_on: expect.arrayContaining([expect.stringMatching(/google_project_iam_member\.Uploads_GcsAgentPublishes/), expect.stringMatching(/google_cloud_run_v2_service_iam_member\.Uploads_TriggerInvokesHandler/)]),
    });
    expect(synth).toHaveResourceWithProperties(ProjectIamMember, {
      role: 'roles/pubsub.publisher',
      member: expect.stringMatching(/^serviceAccount:\$\{data\.google_storage_project_service_account\.Uploads_GcsAgent_[0-9A-F]{8}\.email_address\}$/),
    });
  });

  it('Scheduler publishes hourly with base64 data and attributes, after the scheduler agent is granted publisher', () => {
    expect(synth).toHaveResourceWithProperties(CloudSchedulerJob, {
      schedule: '0 * * * *',
      time_zone: 'Etc/UTC',
      attempt_deadline: '30s',
      retry_config: { retry_count: 3, min_backoff_duration: '5s', max_backoff_duration: '60s', max_doublings: 3 },
      pubsub_target: {
        topic_name: expect.stringMatching(/^\$\{google_pubsub_topic\.Orders_Topic_[0-9A-F]{8}\.id\}$/),
        data: Buffer.from(JSON.stringify({ kind: 'digest', window: 'PT1H' })).toString('base64'),
        attributes: { type: 'digest', source: 'cloud-scheduler' },
      },
      depends_on: expect.arrayContaining([expect.stringMatching(/google_pubsub_topic_iam_member\.Orders_SchedulerPublishes/)]),
    });
    expect(synth).toHaveResourceWithProperties(PubsubTopicIamMember, {
      member: 'serviceAccount:service-${data.google_project.Project.number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com',
      role: 'roles/pubsub.publisher',
    });
  });

  it('BigQuery dataset + partitioned, clustered table with the JSON schema string; retention follows the tier', () => {
    expect(synth).toHaveResourceWithProperties(BigqueryDataset, {
      dataset_id: 'orders_dev',
      location: 'US',
      delete_contents_on_destroy: true,
      default_table_expiration_ms: 7 * 24 * 3600 * 1000,
    });
    expect(synth).toHaveResourceWithProperties(BigqueryTable, {
      table_id: 'order_events',
      schema: JSON.stringify(ORDER_EVENTS_SCHEMA),
      time_partitioning: { type: 'DAY', field: 'event_time', expiration_ms: 7 * 24 * 3600 * 1000 },
      clustering: ['region', 'event_type'],
      deletion_protection: false,
      require_partition_filter: false,
    });
    const table = json.resource.google_bigquery_table;
    expect(JSON.parse((Object.values(table)[0] as { schema: string }).schema).map((c: { name: string }) => c.name)).toEqual([
      'order_id',
      'event_type',
      'region',
      'amount',
      'event_time',
      'delivery_attempt',
    ]);

    const prod = Testing.synth(new EventsStack(Testing.app(), 'p', { tier: 'prod', project: 'proj' }));
    expect(prod).toHaveResourceWithProperties(BigqueryTable, { deletion_protection: true, require_partition_filter: true });
    expect(prod).toHaveResourceWithProperties(BigqueryDataset, { delete_contents_on_destroy: false });
    expect(JSON.parse(prod).resource.google_bigquery_dataset.OrderEvents_Dataset_58C2799E.default_table_expiration_ms).toBeUndefined();
  });

  it('addToApp registers m04-events', () => {
    const app = Testing.app();
    addToApp(app);
    expect(app.node.children.map((c) => c.node.id)).toEqual(['m04-events']);
  });
});

describe('04 · the IAM trap', () => {
  const publishers = ['serviceAccount:a@proj.iam.gserviceaccount.com', 'group:producers@example.com'];

  it('_iam_member: one additive resource per (role, member)', () => {
    const synth = Testing.synth(new IamTrapStack(Testing.app(), 'x', { style: 'member', publishers, project: 'proj' }));
    const json = JSON.parse(synth);
    expect(Object.keys(json.resource.google_pubsub_topic_iam_member)).toHaveLength(2);
    expect(json.resource.google_pubsub_topic_iam_binding).toBeUndefined();
    expect(json.resource.google_pubsub_topic_iam_policy).toBeUndefined();
  });

  it('_iam_binding: one resource whose members list is authoritative for that role', () => {
    const synth = Testing.synth(new IamTrapStack(Testing.app(), 'x', { style: 'binding', publishers, project: 'proj' }));
    expect(synth).toHaveResourceWithProperties(PubsubTopicIamBinding, { role: 'roles/pubsub.publisher', members: publishers });
    expect(JSON.parse(synth).resource.google_pubsub_topic_iam_member).toBeUndefined();
  });

  it('_iam_policy: replaces the whole policy from a data.google_iam_policy document', () => {
    const synth = Testing.synth(new IamTrapStack(Testing.app(), 'x', { style: 'policy', publishers, project: 'proj' }));
    const json = JSON.parse(synth);
    expect(synth).toHaveResourceWithProperties(PubsubTopicIamPolicy, { policy_data: '${data.google_iam_policy.Policy.policy_data}' });
    expect(json.data.google_iam_policy.Policy.binding).toEqual([{ role: 'roles/pubsub.publisher', members: publishers }]);
  });

  it('the events stack itself uses only additive grants', () => {
    const json = JSON.parse(Testing.synth(new EventsStack(Testing.app(), 'x', { tier: 'dev', project: 'proj' })));
    const types = Object.keys(json.resource);
    expect(types.filter((t) => t.endsWith('_iam_binding') || t.endsWith('_iam_policy'))).toEqual([]);
    expect(types.filter((t) => t.endsWith('_iam_member')).length).toBeGreaterThanOrEqual(5);
  });
});

describe('04 · exercise solutions', () => {
  function withStack() {
    const stack = new EventsStack(Testing.app(), 'x', { tier: 'dev', project: 'proj', region: 'us-central1' });
    const projectNumber = '${data.google_project.Project.number}';
    return { stack, projectNumber };
  }

  it('1: BigQuery subscription writes straight into the table after the Pub/Sub agent gets dataEditor', () => {
    const { stack, projectNumber } = withStack();
    new BigQuerySubscription(stack, 'Archive', { tier: ENVIRONMENTS.dev, projectNumber, topics: stack.topics, table: stack.table });
    const synth = Testing.synth(stack);
    expect(synth).toHaveResourceWithProperties(PubsubSubscription, {
      bigquery_config: {
        table: expect.stringMatching(/^\$\{google_bigquery_table\.OrderEvents_Table_[0-9A-F]{8}\.project\}\.\$\{google_bigquery_dataset\.OrderEvents_Dataset_[0-9A-F]{8}\.dataset_id\}\.\$\{google_bigquery_table\.OrderEvents_Table_[0-9A-F]{8}\.table_id\}$/),
        use_table_schema: true,
        drop_unknown_fields: true,
      },
      depends_on: [expect.stringMatching(/google_bigquery_dataset_iam_member\.Archive_AgentWritesDataset/)],
    });
    expect(synth).toHaveResourceWithProperties(BigqueryDatasetIamMember, { role: 'roles/bigquery.dataEditor', member: PUBSUB_AGENT });
  });

  it('2: push subscription with OIDC needs run.invoker for the push SA and tokenCreator for the Pub/Sub agent', () => {
    const { stack, projectNumber } = withStack();
    new PushSubscription(stack, 'Push', {
      tier: ENVIRONMENTS.dev,
      region: 'us-central1',
      projectNumber,
      topics: stack.topics,
      target: stack.uploadTrigger.handler,
      path: '/pubsub/orders',
    });
    const synth = Testing.synth(stack);
    expect(synth).toHaveResourceWithProperties(PubsubSubscription, {
      push_config: {
        push_endpoint: expect.stringMatching(/^\$\{google_cloud_run_v2_service\.Uploads_Handler_[0-9A-F]{8}\.uri\}\/pubsub\/orders$/),
        oidc_token: { service_account_email: expect.stringMatching(/Push_PushAccount/), audience: expect.stringMatching(/\.uri\}$/) },
        attributes: { 'x-goog-version': 'v1' },
      },
      depends_on: expect.arrayContaining([expect.stringMatching(/Push_PushInvokesTarget/), expect.stringMatching(/Push_AgentMintsTokens/)]),
    });
    expect(synth).toHaveResourceWithProperties(ServiceAccountIamMember, { role: 'roles/iam.serviceAccountTokenCreator', member: PUBSUB_AGENT });
  });

  it('3: DLQ alert watches dead_letter_message_count on the source subscription and the DLQ backlog', () => {
    const { stack } = withStack();
    const alert = new DeadLetterAlert(stack, 'DlqAlert', { tier: ENVIRONMENTS.prod, topics: stack.topics, email: 'oncall@example.com' });
    const synth = Testing.synth(stack);
    expect(synth).toHaveResourceWithProperties(MonitoringAlertPolicy, {
      combiner: 'OR',
      severity: 'CRITICAL',
      notification_channels: [expect.stringMatching(/google_monitoring_notification_channel\.DlqAlert_Email/)],
    });
    const policy = JSON.parse(synth).resource.google_monitoring_alert_policy[Object.keys(JSON.parse(synth).resource.google_monitoring_alert_policy)[0]];
    expect(policy.conditions[0].condition_threshold.filter).toContain('pubsub.googleapis.com/subscription/dead_letter_message_count');
    expect(policy.conditions[0].condition_threshold.filter).toContain('Orders_Worker');
    expect(policy.conditions[1].condition_threshold.filter).toContain('num_undelivered_messages');
    expect(policy.conditions[1].condition_threshold.filter).toContain('Orders_DeadLetterMonitor');
    expect(policy.documentation.content).toContain('gcloud pubsub subscriptions pull');
    expect(alert.channel).toBeDefined();
  });
});
