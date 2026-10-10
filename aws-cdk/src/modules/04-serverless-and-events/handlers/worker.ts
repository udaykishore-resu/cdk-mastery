import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { OrderPlaced, SqsBatchResponse, SqsEvent } from './types';

/**
 * SQS worker with partial batch failure reporting.
 *
 * Without `reportBatchItemFailures`, one bad message fails the whole batch and every
 * message in it is retried (and eventually dead-lettered) — including the ones that
 * succeeded. With it, the handler returns the ids that failed and only those return to
 * the queue. Two rules follow:
 *   1. Never throw for a single record; catch per record and collect the id.
 *   2. Be idempotent: a record that succeeded but whose batch partially failed is NOT
 *      redelivered, but at-least-once delivery still applies across SQS itself.
 *
 * The message body is the EventBridge envelope (`detail-type`, `detail`, ...) because the
 * rule targets the queue directly, without an input transformer.
 */
const TABLE_NAME = process.env.TABLE_NAME ?? '';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface Envelope {
  readonly 'detail-type': string;
  readonly detail: OrderPlaced;
}

export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const envelope = JSON.parse(record.body) as Envelope;
      if (envelope['detail-type'] !== 'OrderPlaced') {
        // Not ours: acknowledge (dropping silently is a choice; logging it is mandatory).
        console.warn('ignoring event', { messageId: record.messageId, type: envelope['detail-type'] });
        continue;
      }
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: `ORDER#${envelope.detail.orderId}`, sk: 'META' },
          UpdateExpression: 'SET #s = :processed',
          ExpressionAttributeValues: { ':processed': 'processed', ':placed': 'placed' },
          // Idempotency: only transition placed -> processed; a redelivery is a no-op failure we swallow.
          ConditionExpression: '#s = :placed',
        }),
      );
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'ConditionalCheckFailedException') continue; // already processed
      console.error('record failed', { messageId: record.messageId, receiveCount: record.attributes.ApproximateReceiveCount, err });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
