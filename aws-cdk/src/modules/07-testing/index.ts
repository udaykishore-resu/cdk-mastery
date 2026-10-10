import * as cdk from 'aws-cdk-lib';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import { TestableStack } from './testable-stack';
import { TestableStage } from './testable-stage';

export * from './encrypted-queues-aspect';
export * from './snapshot-helpers';
export * from './testable-stack';
export * from './testable-stage';

/**
 * Module 07 entry point.
 *
 * `M07-Testable` is env-agnostic (the `RegionConfig` mapping is resolved by
 * CloudFormation at deploy time via `AWS::Region`, so no region is needed at synth).
 *
 * `M07-Stage` is a Stage; its stacks appear in `cdk ls` as `M07-Stage/Workload`
 * and `M07-Stage/Config` (hierarchical ids) with stack *names*
 * `M07-Stage-Workload` / `M07-Stage-Config`. That naming difference is one of
 * the things the tests pin down.
 */
export function addToApp(app: cdk.App): void {
  new TestableStack(app, 'M07-Testable', { tier: ENVIRONMENTS.dev });
  new TestableStage(app, 'M07-Stage', { tier: ENVIRONMENTS.dev });
}
