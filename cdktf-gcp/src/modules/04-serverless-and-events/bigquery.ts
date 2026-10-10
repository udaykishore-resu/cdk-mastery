import { Construct } from 'constructs';
import { BigqueryDataset } from '@cdktf/provider-google/lib/bigquery-dataset';
import { BigqueryTable } from '@cdktf/provider-google/lib/bigquery-table';
import { BigqueryDatasetIamMember } from '@cdktf/provider-google/lib/bigquery-dataset-iam-member';
import { EnvironmentTier, mandatoryTags } from '@cdk-mastery/shared';

export interface OrderEventsTableProps {
  readonly tier: EnvironmentTier;
  readonly datasetId: string;
  readonly location: string;
}

/**
 * The BigQuery schema is a JSON *string*, not a typed structure: the provider
 * stores it as `schema = jsonencode([...])` and compares it as JSON. Keep it
 * in TypeScript so it is reviewable and testable, then `JSON.stringify`.
 * Column order matters for the diff; adding a column at the end is an
 * in-place update, anything else is a table replacement (guarded by
 * `deletion_protection`).
 */
export const ORDER_EVENTS_SCHEMA = [
  { name: 'order_id', type: 'STRING', mode: 'REQUIRED', description: 'Business key; de-duplicate on this' },
  { name: 'event_type', type: 'STRING', mode: 'REQUIRED' },
  { name: 'region', type: 'STRING', mode: 'NULLABLE' },
  { name: 'amount', type: 'NUMERIC', mode: 'NULLABLE' },
  { name: 'event_time', type: 'TIMESTAMP', mode: 'REQUIRED', description: 'Pub/Sub publish time' },
  { name: 'delivery_attempt', type: 'INTEGER', mode: 'NULLABLE', description: '>1 means a redelivery' },
] as const;

export class OrderEventsTable extends Construct {
  readonly dataset: BigqueryDataset;
  readonly table: BigqueryTable;

  constructor(scope: Construct, id: string, props: OrderEventsTableProps) {
    super(scope, id);
    const retain = props.tier.retainStatefulResources;

    this.dataset = new BigqueryDataset(this, 'Dataset', {
      datasetId: props.datasetId,
      location: props.location,
      description: 'Order events streamed from Pub/Sub by the order-processor function',
      // Dev tables expire; prod tables do not. Milliseconds, because BigQuery.
      defaultTableExpirationMs: retain ? undefined : props.tier.logRetentionDays * 24 * 3600 * 1000,
      // `destroy` of a non-empty dataset fails unless this is set; prod keeps the guard.
      deleteContentsOnDestroy: !retain,
      labels: mandatoryTags(props.tier, 'events'),
    });

    this.table = new BigqueryTable(this, 'Table', {
      datasetId: this.dataset.datasetId,
      tableId: 'order_events',
      schema: JSON.stringify(ORDER_EVENTS_SCHEMA),
      // Partition by event time (a query with a WHERE on event_time scans only
      // those days); expire partitions in dev; cluster by region for the common filter.
      timePartitioning: {
        type: 'DAY',
        field: 'event_time',
        expirationMs: retain ? undefined : props.tier.logRetentionDays * 24 * 3600 * 1000,
      },
      requirePartitionFilter: retain,
      clustering: ['region', 'event_type'],
      deletionProtection: retain,
      labels: mandatoryTags(props.tier, 'events'),
    });
  }

  /** Additive grant: `member` may insert rows into (and read) tables of the dataset. */
  grantWrite(id: string, member: string): BigqueryDatasetIamMember {
    return new BigqueryDatasetIamMember(this, id, { datasetId: this.dataset.datasetId, role: 'roles/bigquery.dataEditor', member });
  }
}
