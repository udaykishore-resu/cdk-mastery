'use strict';
// Consumer for the work queue. Kept trivial: the module is about the pipeline
// that ships it, not about the function.
exports.handler = async (event) => {
  const n = Array.isArray(event.Records) ? event.Records.length : 0;
  console.log(JSON.stringify({ msg: 'processed', records: n, stage: process.env.STAGE_NAME }));
  return { batchItemFailures: [] };
};
