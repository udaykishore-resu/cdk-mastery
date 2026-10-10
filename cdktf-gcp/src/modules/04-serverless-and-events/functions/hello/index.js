'use strict';
/**
 * Cloud Functions gen2 handler, Pub/Sub-triggered (Eventarc CloudEvent).
 *
 * At-least-once delivery means this runs more than once for the same message
 * when an ack is lost or the retry policy fires. The BigQuery insert uses the
 * message id as insertId so duplicates within the streaming de-dup window
 * (~1 minute) collapse; anything longer-lived must be idempotent on
 * `order_id` at query time (e.g. QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id) = 1).
 */
const functions = require('@google-cloud/functions-framework');
const { BigQuery } = require('@google-cloud/bigquery');

const bigquery = new BigQuery();
const DATASET = process.env.BQ_DATASET;
const TABLE = process.env.BQ_TABLE;

functions.cloudEvent('processOrder', async (cloudEvent) => {
  const message = cloudEvent.data && cloudEvent.data.message;
  if (!message || !message.data) {
    // Malformed → do not throw: throwing would retry forever (or until the DLQ takes it).
    console.warn('Ignoring event without message data', cloudEvent.id);
    return;
  }
  const payload = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));
  const attributes = message.attributes || {};

  const row = {
    insertId: message.messageId,
    json: {
      order_id: payload.orderId,
      event_type: attributes.type || 'unknown',
      region: attributes.region || null,
      amount: payload.amount == null ? null : Number(payload.amount),
      event_time: message.publishTime || new Date().toISOString(),
      delivery_attempt: cloudEvent.deliveryattempt ? Number(cloudEvent.deliveryattempt) : null,
    },
  };

  try {
    await bigquery.dataset(DATASET).table(TABLE).insert([row], { raw: true });
  } catch (err) {
    // A thrown error → non-2xx → Pub/Sub redelivers with backoff, then dead-letters.
    console.error('BigQuery insert failed', err.errors || err);
    throw err;
  }
});
