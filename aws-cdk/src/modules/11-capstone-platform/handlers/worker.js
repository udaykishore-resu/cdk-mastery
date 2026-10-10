'use strict';
/**
 * Orders worker: consumes OrderCreated events from SQS (fed by EventBridge) and
 * marks the order CONFIRMED. Reports partial batch failures so one bad message
 * does not force a whole batch back onto the queue.
 */
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME;

exports.handler = async (event) => {
  const batchItemFailures = [];
  for (const record of event.Records || []) {
    try {
      const envelope = JSON.parse(record.body); // EventBridge → SQS delivers the event JSON as the body
      const detail = envelope.detail || {};
      if (!detail.orderId) throw new Error('missing orderId');
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `ORDER#${detail.orderId}`, sk: 'META' },
        UpdateExpression: 'SET #s = :confirmed, confirmedAt = :now',
        ConditionExpression: '#s = :pending',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':confirmed': 'CONFIRMED', ':pending': 'PENDING', ':now': new Date().toISOString() },
      }));
    } catch (err) {
      // ConditionalCheckFailed = already processed (at-least-once delivery); treat as success.
      if (err && err.name === 'ConditionalCheckFailedException') continue;
      console.error(JSON.stringify({ msg: 'failed', messageId: record.messageId, error: String(err) }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
