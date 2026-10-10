'use strict';
// Plain JavaScript handler for the QueueWorker demo. Returns partial batch failures.
exports.handler = async (event) => {
  const batchItemFailures = [];
  for (const record of event.Records ?? []) {
    try {
      const body = JSON.parse(record.body);
      if (body && body.fail === true) throw new Error('simulated failure');
      console.log(JSON.stringify({ level: 'info', msg: 'processed', messageId: record.messageId }));
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'failed', messageId: record.messageId, error: String(err) }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
