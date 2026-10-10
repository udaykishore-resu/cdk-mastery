'use strict';
// Cloud Functions gen2 worker: consumes order events from Pub/Sub (via Eventarc).
// Throwing makes Eventarc retry (RETRY_POLICY_RETRY); after maxDeliveryAttempts
// the message lands on the dead-letter topic, which the observability stack alerts on.
const functions = require('@google-cloud/functions-framework');

functions.cloudEvent('handleOrder', (cloudEvent) => {
  const message = cloudEvent.data && cloudEvent.data.message;
  const payload = message && message.data ? Buffer.from(message.data, 'base64').toString() : '{}';
  const order = JSON.parse(payload);
  if (!order.orderId) {
    throw new Error('order event without orderId');
  }
  console.log(JSON.stringify({ severity: 'INFO', message: 'order processed', orderId: order.orderId }));
});
