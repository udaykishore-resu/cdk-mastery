import * as cdk from 'aws-cdk-lib';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import { HandBuiltServiceStack } from './handbuilt-service';
import { NetworkStack } from './network';
import { PatternServiceStack } from './pattern-service';

export * from './handbuilt-service';
export * from './network';
export * from './pattern-service';

/**
 * All three stacks are env-specific (env from cdk.json context): the VPC L2 needs AZ names,
 * and the service stacks reference the VPC across stacks, which requires matching envs.
 *
 *   M03-Network            VPC, endpoints, flow logs
 *   M03-PatternService     ecs_patterns.ApplicationLoadBalancedFargateService in that VPC
 *   M03-HandBuiltService   the same service from L2s, plus a database SG wired with `connections`
 */
export function addToApp(app: cdk.App): void {
  const tier = ENVIRONMENTS.dev;
  const env = {
    account: app.node.tryGetContext('cdk-mastery:account') ?? '111111111111',
    region: app.node.tryGetContext('cdk-mastery:region') ?? 'us-east-1',
  };

  const network = new NetworkStack(app, 'M03-Network', { tier, env, description: 'cdk-mastery module 03: cost-aware VPC' });
  new PatternServiceStack(app, 'M03-PatternService', { tier, env, vpc: network.vpc, description: 'cdk-mastery module 03: L3 Fargate service' });
  new HandBuiltServiceStack(app, 'M03-HandBuiltService', { tier, env, vpc: network.vpc, description: 'cdk-mastery module 03: hand-built Fargate service' });
}
