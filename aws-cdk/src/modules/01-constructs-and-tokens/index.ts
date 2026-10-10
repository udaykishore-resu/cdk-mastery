import * as cdk from 'aws-cdk-lib';
import { LevelsStack } from './levels';
import { PrefixedIdsStack } from './logical-ids';
import { ParametersStack } from './parameters-and-outputs';
import { TokensStack } from './tokens';

export * from './levels';
export * from './logical-ids';
export * from './parameters-and-outputs';
export * from './tokens';

/**
 * All four stacks are env-agnostic (no `env`): nothing in this module needs to know the
 * account or region at synth time, and `TokensStack` deliberately shows `region` as a token.
 */
export function addToApp(app: cdk.App): void {
  const tier = 'dev';
  new LevelsStack(app, 'M01-Levels', { tier, description: 'cdk-mastery module 01: L1 vs L2 vs L3 on one S3 bucket' });
  new PrefixedIdsStack(app, 'M01-LogicalIds', { logicalIdPrefix: 'Dev', description: 'cdk-mastery module 01: logical-ID derivation and overrides' });
  new TokensStack(app, 'M01-Tokens', { tier, description: 'cdk-mastery module 01: tokens, Lazy, Fn, Duration and Size' });
  new ParametersStack(app, 'M01-Parameters', { tier, description: 'cdk-mastery module 01: CfnParameter, CfnOutput and Annotations' });
}
