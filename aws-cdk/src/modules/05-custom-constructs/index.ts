import * as cdk from 'aws-cdk-lib';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import { ConstructsDemoStack } from './demo-stack';

export * from './demo-stack';
export * from './queue-worker';
export * from './secure-bucket';
export * from './service-dashboard';

/** One env-agnostic stack that composes the three constructs. */
export function addToApp(app: cdk.App): void {
  new ConstructsDemoStack(app, 'M05-Constructs', {
    tier: ENVIRONMENTS.dev,
    description: 'cdk-mastery module 05: SecureBucket, QueueWorker and ServiceDashboard L3 constructs',
  });
}
