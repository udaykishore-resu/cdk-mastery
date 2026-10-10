import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/**
 * Exercise 2 — ordered, deduplicated processing with FIFO queues.
 *
 * Constraints FIFO imposes that the standard pipeline did not have:
 *   - queue names end in `.fifo`; a FIFO queue's DLQ must also be FIFO;
 *   - every message needs a MessageGroupId (ordering scope) — the rule target sets it;
 *   - deduplication needs an id: `contentBasedDeduplication` hashes the body (5-minute window);
 *   - Lambda polls per message group; `maxBatchingWindow` is NOT allowed, and batches never mix groups;
 *   - throughput is 300 msg/s per group (3,000 with batching) unless `fifoThroughputLimit`
 *     is PER_MESSAGE_GROUP_ID with `deduplicationScope` MESSAGE_GROUP (high-throughput mode).
 */
export interface FifoPipelineProps {
  readonly bus: events.IEventBus;
  readonly worker: lambda.IFunction;
  /** Every OrderPlaced for one customer is processed in order; different customers in parallel. */
  readonly messageGroupId?: string;
}

export class FifoPipeline extends Construct {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly rule: events.Rule;

  constructor(scope: Construct, id: string, props: FifoPipelineProps) {
    super(scope, id);

    this.deadLetterQueue = new sqs.Queue(this, 'Dlq', {
      fifo: true,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.queue = new sqs.Queue(this, 'Queue', {
      fifo: true,
      enforceSSL: true,
      contentBasedDeduplication: true,
      deduplicationScope: sqs.DeduplicationScope.MESSAGE_GROUP,
      fifoThroughputLimit: sqs.FifoThroughputLimit.PER_MESSAGE_GROUP_ID,
      visibilityTimeout: cdk.Duration.seconds(180),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 3 },
    });

    this.rule = new events.Rule(this, 'OrderPlaced', {
      eventBus: props.bus,
      eventPattern: { source: ['cdk-mastery.orders'], detailType: ['OrderPlaced'] },
      targets: [
        new targets.SqsQueue(this.queue, {
          // A static group id serialises everything; a per-customer id is the usual choice
          // (EventBridge cannot compute it from the event, so it is set per rule).
          messageGroupId: props.messageGroupId ?? 'orders',
          deadLetterQueue: this.deadLetterQueue,
        }),
      ],
    });

    props.worker.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: 10,
        reportBatchItemFailures: true,
        // no maxBatchingWindow: not supported for FIFO
      }),
    );
  }
}
