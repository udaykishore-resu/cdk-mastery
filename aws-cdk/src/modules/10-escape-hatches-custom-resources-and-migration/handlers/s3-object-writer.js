'use strict';
/**
 * Exercise 3 — onEvent-only handler for Custom::S3ObjectWriter.
 * Writes `Body` to `s3://Bucket/Key` on Create/Update and deletes it on Delete.
 * Uses AWS SDK v3, which the Node.js 22 Lambda runtime bundles; no packaging needed.
 */
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({});

exports.handler = async (event) => {
  const { Bucket, Key, Body, ContentType } = event.ResourceProperties;
  const physicalId = `s3://${Bucket}/${Key}`;
  switch (event.RequestType) {
    case 'Create':
    case 'Update':
      await s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: ContentType || 'text/plain' }));
      return { PhysicalResourceId: physicalId, Data: { Url: physicalId, Bytes: Buffer.byteLength(Body || '') } };
    case 'Delete':
      try {
        await s3.send(new DeleteObjectCommand({ Bucket, Key }));
      } catch (err) {
        // A missing bucket/object during rollback must not block stack deletion.
        if (!['NoSuchBucket', 'NoSuchKey', 'NotFound'].includes(err.name)) throw err;
      }
      return { PhysicalResourceId: event.PhysicalResourceId };
    default:
      throw new Error(`Unknown RequestType ${event.RequestType}`);
  }
};
