import * as cdk from 'aws-cdk-lib';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import { ApiStack } from './api-stack';
import { EventsStack } from './events-stack';
import { SagaStack } from './saga-stack';

export * from './api-stack';
export * from './events-stack';
export * from './saga-stack';

/**
 * Three env-agnostic stacks (no lookups; every reference is a cross-stack token):
 *   M04-Api     TableV2 + GSI, NodejsFunction, alias + CodeDeploy canary, HTTP API
 *   M04-Events  EventBridge bus/rule → SQS + DLQ → worker (partial batch failures); Scheduler cron
 *   M04-Saga    Step Functions saga writing to the table with DynamoPutItem
 * Events and Saga reference the table from Api (weak references per cdk.json).
 */
export function addToApp(app: cdk.App): void {
  const tier = ENVIRONMENTS.dev;
  const api = new ApiStack(app, 'M04-Api', { tier, description: 'cdk-mastery module 04: HTTP API -> Lambda -> DynamoDB with canary alias' });
  new EventsStack(app, 'M04-Events', { tier, table: api.table, description: 'cdk-mastery module 04: EventBridge -> SQS -> worker, Scheduler' });
  new SagaStack(app, 'M04-Saga', { tier, table: api.table, description: 'cdk-mastery module 04: Step Functions saga' });
}
