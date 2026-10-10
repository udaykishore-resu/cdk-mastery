import * as cdk from 'aws-cdk-lib';
import { PlatformStage } from './platform-stage';
import { targetFor } from './targets';

export * from './feature-flags';
export * from './global-stack';
export * from './platform-stage';
export * from './regional-stack';
export * from './synthesizer';
export * from './targets';

/**
 * Module 09 entry point.
 *
 * Two Stages from one class and one config table:
 *   M09-Dev  → 111111111111 / us-east-1            (regional stack only)
 *   M09-Prod → 222222222222 / us-west-2 + us-east-1 (global + regional, cross-region reference)
 *
 * `cdk ls` shows hierarchical ids (`M09-Prod/Global`, `M09-Prod/Regional`);
 * CloudFormation shows the explicit `stackName`s (`revan-platform-prod-global-use1`,
 * `revan-platform-prod-regional-usw2`). Deploy with either:
 *   npx cdk deploy 'M09-Prod/**'
 * Accounts can be overridden per tier from context:
 *   npx cdk synth -c cdk-mastery:prod-account=333333333333
 *
 * Every stack here has a concrete env by construction (cross-region references
 * require it), and every stack uses the tier's qualifier — bootstrap accordingly
 * before deploying (see synthesizer.ts for the exact commands).
 */
export function addToApp(app: cdk.App): void {
  new PlatformStage(app, 'M09-Dev', { target: targetFor('dev', app) });
  new PlatformStage(app, 'M09-Prod', { target: targetFor('prod', app) });
}
