/**
 * Minimal ambient declarations for the AWS SDK v3 modules the handlers use.
 *
 * This repo does not install `@aws-sdk/*` (or `@types/aws-lambda`): the Node.js 22 Lambda
 * runtime ships SDK v3, and `NodejsFunction` marks `@aws-sdk/*` as external by default, so
 * esbuild leaves the imports untouched and the runtime resolves them. These declarations
 * exist only so the handlers type-check inside the repo. In a real service you would
 * `npm i -D @aws-sdk/lib-dynamodb @types/aws-lambda` and delete this file.
 */
declare module '@aws-sdk/client-dynamodb' {
  export class DynamoDBClient {
    constructor(config?: Record<string, unknown>);
  }
}

declare module '@aws-sdk/lib-dynamodb' {
  import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
  export interface CommandOutput {
    Item?: Record<string, unknown>;
    Items?: Record<string, unknown>[];
    Count?: number;
  }
  export class DynamoDBDocumentClient {
    static from(client: DynamoDBClient, options?: Record<string, unknown>): DynamoDBDocumentClient;
    send(command: unknown): Promise<CommandOutput>;
  }
  export class PutCommand {
    constructor(input: { TableName: string; Item: Record<string, unknown>; ConditionExpression?: string });
  }
  export class GetCommand {
    constructor(input: { TableName: string; Key: Record<string, unknown> });
  }
  export class QueryCommand {
    constructor(input: {
      TableName: string;
      IndexName?: string;
      KeyConditionExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
      Limit?: number;
      ScanIndexForward?: boolean;
    });
  }
  export class UpdateCommand {
    constructor(input: {
      TableName: string;
      Key: Record<string, unknown>;
      UpdateExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
      ConditionExpression?: string;
    });
  }
}
