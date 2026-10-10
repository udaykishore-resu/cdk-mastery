import { TerraformOutput, TerraformStack, Token } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { RandomProvider } from '@cdktf/provider-random/lib/provider';
import { Password } from '@cdktf/provider-random/lib/password';
import { DataGoogleProject } from '@cdktf/provider-google/lib/data-google-project';
import { ProjectService } from '@cdktf/provider-google/lib/project-service';
import { SecretManagerSecret } from '@cdktf/provider-google/lib/secret-manager-secret';
import { SecretManagerSecretVersion } from '@cdktf/provider-google/lib/secret-manager-secret-version';
import { environmentFor, mandatoryTags, resourceName } from '@cdk-mastery/shared';
import { OrderEventsTable } from './bigquery';
import { gcpProject, gcpRegion } from './gcp-config';
import { OrderProcessorFunction } from './order-processor-function';
import { OrderTopics } from './pubsub';
import { DigestSchedule } from './scheduler';
import { UploadTrigger } from './upload-trigger';

export interface EventsStackProps {
  readonly tier: string;
  readonly project?: string;
  readonly region?: string;
}

const REQUIRED_APIS = [
  'pubsub.googleapis.com',
  'cloudfunctions.googleapis.com',
  'cloudbuild.googleapis.com',
  'run.googleapis.com',
  'eventarc.googleapis.com',
  'cloudscheduler.googleapis.com',
  'bigquery.googleapis.com',
  'secretmanager.googleapis.com',
  'artifactregistry.googleapis.com',
];

/**
 * The event-driven half of a platform, in one stack:
 *
 *   Scheduler ─(hourly, type=digest)─▶ orders topic ◀─(type=order.created)─ producers
 *                                          │ eventTrigger (Eventarc-managed subscription)
 *                                          ▼
 *                                   order-processor (Functions gen2) ─▶ BigQuery order_events
 *                                          │ 5 failures
 *                                          ▼
 *                                   orders-dead-letter ─▶ monitor subscription
 *   uploads bucket ─(object finalized)─▶ Eventarc ─▶ upload-handler (Cloud Run)
 */
export class EventsStack extends TerraformStack {
  readonly topics: OrderTopics;
  readonly table: OrderEventsTable;
  readonly processor: OrderProcessorFunction;
  readonly uploadTrigger: UploadTrigger;
  readonly digest: DigestSchedule;
  readonly webhookSecret: SecretManagerSecret;

  constructor(scope: Construct, id: string, props: EventsStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    const project = props.project ?? gcpProject();
    const region = props.region ?? gcpRegion();
    new GoogleProvider(this, 'Google', { project, region });
    new RandomProvider(this, 'Random');
    const name = (component: string) => resourceName({ org: 'cdkm', service: 'events', env: tier.name, component });

    const apis = REQUIRED_APIS.map((api) => {
      const short = api.split('.')[0];
      return new ProjectService(this, `Api${short.charAt(0).toUpperCase()}${short.slice(1)}`, {
        service: api,
        disableOnDestroy: false,
      });
    });

    // Service agents are addressed by project *number*.
    const projectFacts = new DataGoogleProject(this, 'Project');
    const projectNumber = Token.asString(projectFacts.number);

    this.topics = new OrderTopics(this, 'Orders', { tier, name: name('orders'), projectNumber });
    this.table = new OrderEventsTable(this, 'OrderEvents', { tier, datasetId: `orders_${tier.name}`, location: 'US' });

    // A secret the function needs (for calling a webhook); generated, never typed.
    const token = new Password(this, 'WebhookToken', { length: 48, special: false });
    this.webhookSecret = new SecretManagerSecret(this, 'WebhookSecret', {
      secretId: name('webhook-token'),
      replication: { auto: {} },
      labels: mandatoryTags(tier, 'events'),
      dependsOn: apis,
    });
    new SecretManagerSecretVersion(this, 'WebhookSecretVersion', { secret: this.webhookSecret.id, secretData: token.result });

    this.processor = new OrderProcessorFunction(this, 'OrderProcessor', {
      tier,
      project,
      region,
      topics: this.topics,
      table: this.table,
      webhookSecretId: this.webhookSecret.secretId,
      dependsOn: apis,
    });

    this.uploadTrigger = new UploadTrigger(this, 'Uploads', { tier, project, region, dependsOn: apis });
    this.digest = new DigestSchedule(this, 'Digest', { tier, region, projectNumber, topics: this.topics, dependsOn: apis });

    new TerraformOutput(this, 'orders_topic', { value: this.topics.topic.id });
    new TerraformOutput(this, 'dead_letter_subscription', { value: this.topics.deadLetterSubscription.name });
    new TerraformOutput(this, 'function_name', { value: this.processor.fn.name });
    new TerraformOutput(this, 'uploads_bucket', { value: this.uploadTrigger.uploads.name });
    new TerraformOutput(this, 'bigquery_table', { value: `${this.table.dataset.datasetId}.${this.table.table.tableId}` });
  }
}
