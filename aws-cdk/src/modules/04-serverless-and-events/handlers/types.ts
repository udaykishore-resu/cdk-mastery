/**
 * Event shapes, hand-declared. `@types/aws-lambda` has the canonical versions
 * (`APIGatewayProxyEventV2`, `SQSEvent`, `SQSBatchResponse`); these are the fields we use.
 */
export interface HttpApiEvent {
  readonly routeKey: string; // e.g. "GET /orders/{id}"
  readonly rawPath: string;
  readonly pathParameters?: Record<string, string | undefined>;
  readonly queryStringParameters?: Record<string, string | undefined>;
  readonly body?: string;
  readonly isBase64Encoded: boolean;
  readonly requestContext: { readonly requestId: string; readonly http: { readonly method: string } };
}

export interface HttpApiResult {
  readonly statusCode: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface SqsRecord {
  readonly messageId: string;
  readonly receiptHandle: string;
  readonly body: string;
  readonly attributes: { readonly ApproximateReceiveCount: string };
}

export interface SqsEvent {
  readonly Records: SqsRecord[];
}

/** Returned when `reportBatchItemFailures` is on: only these ids go back to the queue. */
export interface SqsBatchResponse {
  readonly batchItemFailures: { readonly itemIdentifier: string }[];
}

export interface OrderPlaced {
  readonly orderId: string;
  readonly customerId: string;
  readonly total: number;
  readonly placedAt: string;
}

export interface Order extends OrderPlaced {
  readonly pk: string; // ORDER#<id>
  readonly sk: string; // META
  readonly gsi1pk: string; // CUSTOMER#<customerId>
  readonly gsi1sk: string; // <placedAt>
  readonly status: 'placed' | 'processed' | 'failed';
}
