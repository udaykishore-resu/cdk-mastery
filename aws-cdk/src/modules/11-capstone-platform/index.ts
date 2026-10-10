import * as cdk from 'aws-cdk-lib';
import { PIPELINE_ENV, PLATFORM_TARGETS } from './config';
import { OrdersPlatformStage } from './orders-platform-stage';
import { PipelineStack } from './pipeline-stack';

export * from './config';
export * from './governance';
export * from './orders-platform-stage';
export * from './pipeline-stack';
export * from './stacks/api-stack';
export * from './stacks/data-stack';
export * from './stacks/network-stack';
export * from './stacks/observability-stack';
export * from './stacks/worker-stack';

/**
 * Module 11 entry point.
 *
 *   M11-Dev       — the platform for the dev tier   (111111111111 / us-east-1)
 *   M11-Prod      — the platform for the prod tier  (222222222222 / us-west-2)
 *   M11-Pipeline  — the self-mutating pipeline in the dev account that deploys
 *                   its *own* copies of both stages (M11-Pipeline/M11-Dev/…,
 *                   M11-Pipeline/M11-Prod/…) with the same stack names.
 *
 * The app-level stages exist so an operator can `cdk deploy 'M11-Dev/**'` from a
 * workstation during bootstrap or an incident; day to day, only the pipeline
 * deploys. Both paths produce byte-identical templates because they instantiate
 * the same class with the same targets.
 */
export function addToApp(app: cdk.App): void {
  const alarmEmail = app.node.tryGetContext('cdk-mastery:alarm-email') as string | undefined;

  new OrdersPlatformStage(app, 'M11-Dev', { tier: PLATFORM_TARGETS.dev.tier, env: PLATFORM_TARGETS.dev.env, alarmEmail });
  new OrdersPlatformStage(app, 'M11-Prod', { tier: PLATFORM_TARGETS.prod.tier, env: PLATFORM_TARGETS.prod.env, alarmEmail });

  new PipelineStack(app, 'M11-Pipeline', {
    env: PIPELINE_ENV,
    repo: String(app.node.tryGetContext('cdk-mastery:repo') ?? 'revan/cdk-mastery'),
    branch: 'main',
    connectionArn:
      app.node.tryGetContext('cdk-mastery:connectionArn') ??
      `arn:aws:codeconnections:${PIPELINE_ENV.region}:${PIPELINE_ENV.account}:connection/00000000-0000-0000-0000-000000000000`,
  });
}
