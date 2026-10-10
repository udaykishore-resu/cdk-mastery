/**
 * Exercise 1 — skip the function: a BigQuery subscription.
 *
 * Pub/Sub can write directly into a BigQuery table. No code, no cold starts,
 * no retries to reason about — but also no transformation, no idempotency
 * logic, and the message JSON must match the table schema (`useTableSchema`).
 * Use it for raw event archiving next to the processed table, and keep the
 * function for anything that needs logic.
 *
 * The writes are performed by the *Pub/Sub service agent*, which therefore
 * needs `roles/bigquery.dataEditor` on the dataset (and metadata read, which
 * dataEditor includes). Forgetting this yields a subscription in state
 * "RESOURCE_ERROR" with a permission message in the console — and no rows.
 */
import { Construct } from 'constructs';
import { PubsubSubscription } from '@cdktf/provider-google/lib/pubsub-subscription';
import { BigqueryDatasetIamMember } from '@cdktf/provider-google/lib/bigquery-dataset-iam-member';
import { EnvironmentTier, mandatoryTags } from '@cdk-mastery/shared';
import { OrderEventsTable } from '../bigquery';
import { OrderTopics } from '../pubsub';

export interface BigQuerySubscriptionProps {
  readonly tier: EnvironmentTier;
  readonly projectNumber: string;
  readonly topics: OrderTopics;
  readonly table: OrderEventsTable;
}

export class BigQuerySubscription extends Construct {
  readonly subscription: PubsubSubscription;

  constructor(scope: Construct, id: string, props: BigQuerySubscriptionProps) {
    super(scope, id);
    const pubsubAgent = `serviceAccount:service-${props.projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com`;

    const writer = new BigqueryDatasetIamMember(this, 'AgentWritesDataset', {
      datasetId: props.table.dataset.datasetId,
      role: 'roles/bigquery.dataEditor',
      member: pubsubAgent,
    });

    this.subscription = new PubsubSubscription(this, 'Subscription', {
      name: `${props.topics.topic.name}-to-bigquery`,
      topic: props.topics.topic.id,
      // Same DLQ: rows that BigQuery rejects (schema mismatch) end up there
      // after maxDeliveryAttempts, instead of being retried forever.
      deadLetterPolicy: { deadLetterTopic: props.topics.deadLetterTopic.id, maxDeliveryAttempts: 5 },
      expirationPolicy: { ttl: '' },
      bigqueryConfig: {
        // "project.dataset.table" — the provider wants the fully-qualified id.
        table: `${props.table.table.project}.${props.table.dataset.datasetId}.${props.table.table.tableId}`,
        useTableSchema: true,
        // Extra JSON fields not in the schema are dropped rather than failing the write.
        dropUnknownFields: true,
      },
      labels: { ...mandatoryTags(props.tier, 'events'), purpose: 'raw-archive' },
      dependsOn: [writer],
    });
  }
}
