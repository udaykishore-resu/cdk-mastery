import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { HttpApiEvent, HttpApiResult, Order } from './types';

/**
 * HTTP API handler: GET /orders/{id}, GET /customers/{id}/orders, POST /orders.
 *
 * Single-table layout (see api-stack.ts for the GSI definition):
 *   pk = ORDER#<orderId>, sk = META            → get by id
 *   gsi1pk = CUSTOMER#<customerId>, gsi1sk = placedAt → list a customer's orders, newest first
 *
 * The client is created once per container (outside the handler) so warm invocations reuse
 * the connection. TABLE_NAME is injected by CDK; never hard-code resource names in handlers.
 */
const TABLE_NAME = process.env.TABLE_NAME ?? '';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

const json = (statusCode: number, body: unknown): HttpApiResult => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export async function handler(event: HttpApiEvent): Promise<HttpApiResult> {
  switch (event.routeKey) {
    case 'GET /orders/{id}': {
      const id = event.pathParameters?.id;
      if (!id) return json(400, { message: 'missing id' });
      const out = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: `ORDER#${id}`, sk: 'META' } }));
      return out.Item ? json(200, out.Item) : json(404, { message: 'not found' });
    }
    case 'GET /customers/{id}/orders': {
      const id = event.pathParameters?.id;
      if (!id) return json(400, { message: 'missing id' });
      const out = await ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: 'gsi1',
          KeyConditionExpression: 'gsi1pk = :pk',
          ExpressionAttributeValues: { ':pk': `CUSTOMER#${id}` },
          ScanIndexForward: false,
          Limit: 50,
        }),
      );
      return json(200, { items: out.Items ?? [], count: out.Count ?? 0 });
    }
    case 'POST /orders': {
      if (!event.body) return json(400, { message: 'missing body' });
      let input: { customerId?: string; total?: number };
      try {
        input = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
      } catch {
        return json(400, { message: 'invalid json' });
      }
      if (!input.customerId || typeof input.total !== 'number') return json(422, { message: 'customerId and total are required' });
      const placedAt = new Date().toISOString();
      const orderId = event.requestContext.requestId; // idempotent per request
      const order: Order = {
        pk: `ORDER#${orderId}`,
        sk: 'META',
        gsi1pk: `CUSTOMER#${input.customerId}`,
        gsi1sk: placedAt,
        orderId,
        customerId: input.customerId,
        total: input.total,
        placedAt,
        status: 'placed',
      };
      await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: { ...order }, ConditionExpression: 'attribute_not_exists(pk)' }));
      return json(201, order);
    }
    default:
      return json(404, { message: `no route for ${event.routeKey}` });
  }
}
