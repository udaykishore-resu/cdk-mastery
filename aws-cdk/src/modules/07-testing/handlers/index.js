'use strict';
// Plain-JS handler: no bundling, no Docker, packaged by `lambda.Code.fromAsset`.
// The asset hash is the SHA-256 of this directory's content, so editing this
// comment changes `S3Key` in the template — see the snapshot discussion.
exports.handler = async (event) => {
  const records = Array.isArray(event.Records) ? event.Records.length : 0;
  return { statusCode: 200, body: JSON.stringify({ processed: records, table: process.env.TABLE_NAME }) };
};
