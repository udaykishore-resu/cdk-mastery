import { App } from 'cdktf';
import { GovernedStack } from './governed-stack';
import { OrgPoliciesStack } from './org-policies-stack';

export * from './gcp-config';
export * from './labels-aspect';
export * from './no-public-buckets-aspect';
export * from './require-cmek-aspect';
export * from './policy-bridge';
export * from './stateful-protection-aspect';
export * from './governed-stack';
export * from './org-policies-stack';

/**
 * Two stacks: the governed workload and the org-policy constraints that back it.
 * They are separate on purpose: constraints are owned by the security team and
 * change at a different cadence (and blast radius) from workloads.
 */
export function addToApp(app: App): void {
  new GovernedStack(app, 'm06-governed', { tier: 'prod' });
  new OrgPoliciesStack(app, 'm06-org-policies');
}
