import { Construct } from 'constructs';
import { BigqueryTable } from '@cdktf/provider-google/lib/bigquery-table';
import { BigqueryTableIamMember } from '@cdktf/provider-google/lib/bigquery-table-iam-member';
import { PubsubSubscription } from '@cdktf/provider-google/lib/pubsub-subscription';
import { PubsubTopic } from '@cdktf/provider-google/lib/pubsub-topic';

export interface DeadLetterArchiveProps {
  readonly deadLetterTopic: PubsubTopic;
  readonly datasetId: string;
  readonly projectNumber: string;
  readonly labels?: Record<string, string>;
  readonly retainStatefulResources: boolean;
}

/**
 * Exercise 2 (medium): archive dead-lettered messages to BigQuery.
 *
 * A pull subscription on the DLQ keeps messages for 7 days; after that they
 * are gone, and "what failed last month" has no answer. A BigQuery
 * subscription writes every dead-lettered message (with metadata: original
 * subscription, publish time, attributes) into a table, so failures are
 * queryable forever and replay is a `SELECT`.
 *
 * The Pub/Sub service agent needs `roles/bigquery.dataEditor` on the table
 * (and `bigquery.metadataViewer`, granted at project level by default for the
 * agent) — without it the subscription is created and silently never writes.
 */
export class DeadLetterArchive extends Construct {
  readonly table: BigqueryTable;
  readonly subscription: PubsubSubscription;

  constructor(scope: Construct, id: string, props: DeadLetterArchiveProps) {
    super(scope, id);
    this.table = new BigqueryTable(this, 'Table', {
      datasetId: props.datasetId,
      tableId: 'dead_letters',
      deletionProtection: props.retainStatefulResources,
      timePartitioning: { type: 'DAY', field: 'publish_time' },
      labels: props.labels,
      // Pub/Sub's write_metadata schema; `data` holds the raw message bytes.
      schema: JSON.stringify([
        { name: 'subscription_name', type: 'STRING', mode: 'NULLABLE' },
        { name: 'message_id', type: 'STRING', mode: 'NULLABLE' },
        { name: 'publish_time', type: 'TIMESTAMP', mode: 'NULLABLE' },
        { name: 'data', type: 'BYTES', mode: 'NULLABLE' },
        { name: 'attributes', type: 'STRING', mode: 'NULLABLE' },
      ]),
    });
    const writer = new BigqueryTableIamMember(this, 'PubsubWriter', {
      datasetId: props.datasetId,
      tableId: this.table.tableId,
      role: 'roles/bigquery.dataEditor',
      member: `serviceAccount:service-${props.projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com`,
    });
    this.subscription = new PubsubSubscription(this, 'Subscription', {
      name: `${props.deadLetterTopic.name}-archive`,
      topic: props.deadLetterTopic.name,
      bigqueryConfig: { table: `${this.table.project}.${this.table.datasetId}.${this.table.tableId}`, writeMetadata: true },
      expirationPolicy: { ttl: '' },
      labels: props.labels,
      dependsOn: [writer],
    });
  }
}
