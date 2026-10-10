import { App } from 'cdktf';
import { EventsStack } from './events-stack';

export * from './gcp-config';
export * from './pubsub';
export * from './bigquery';
export * from './order-processor-function';
export * from './upload-trigger';
export * from './scheduler';
export * from './iam-trap';
export * from './events-stack';

/** One stack: `m04-events`. The IAM-trap stack is test-only on purpose. */
export function addToApp(app: App): void {
  new EventsStack(app, 'm04-events', { tier: 'dev' });
}
