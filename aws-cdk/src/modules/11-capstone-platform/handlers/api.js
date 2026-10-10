'use strict';
/**
 * Orders API: POST /orders creates an order, GET /orders/{id} reads it.
 * Plain JS (no bundling) so the whole capstone synthesizes without Docker or esbuild.
 * SDK v3 is provided by the Lambda runtime.
 */
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');
const crypto = require('node:crypto');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const events = new EventBridgeClient({});
const TABLE = process.env.TABLE_NAME;
const BUS = process.env.EVENT_BUS_NAME;

exports.handler = async (event) => {
  const method = event.requestContext && event.requestContext.http ? event.requestContext.http.method : 'GET';
  const rawPath = event.rawPath || '/';

  if (method === 'GET' && rawPath === '/health') return json(200, { ok: true });

  if (method === 'POST' && rawPath === '/orders') {
    const body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : {};
    if (!body.customerId || !Array.isArray(body.items) || body.items.length === 0) return json(400, { error: 'customerId and items are required' });
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const item = { pk: `ORDER#${id}`, sk: 'META', orderId: id, customerId: body.customerId, items: body.items, status: 'PENDING', createdAt };
    await ddb.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }));
    await events.send(new PutEventsCommand({
      Entries: [{ EventBusName: BUS, Source: 'orders.api', DetailType: 'OrderCreated', Detail: JSON.stringify({ orderId: id, customerId: body.customerId }) }],
    }));
    return json(201, { orderId: id, status: 'PENDING' });
  }

  const match = rawPath.match(/^\/orders\/([^/]+)$/);
  if (method === 'GET' && match) {
    const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: `ORDER#${match[1]}`, sk: 'META' } }));
    return res.Item ? json(200, res.Item) : json(404, { error: 'not found' });
  }
  return json(404, { error: 'route not found' });
};

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
