import { App } from 'cdktf';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import { OrdersPlatform } from './platform';

export * from './gcp-config';
export * from './platform-stack';
export * from './platform';
export * from './stacks/foundation-stack';
export * from './stacks/network-stack';
export * from './stacks/data-stack';
export * from './stacks/messaging-stack';
export * from './stacks/compute-stack';
export * from './stacks/observability-stack';

/**
 * dev and prod, twelve stacks, one factory. Add `staging` here when the
 * second environment is real; TIER_SETTINGS already has its numbers.
 */
export function addToApp(app: App): void {
  new OrdersPlatform(app, { tier: ENVIRONMENTS.dev });
  new OrdersPlatform(app, { tier: ENVIRONMENTS.prod });
}
