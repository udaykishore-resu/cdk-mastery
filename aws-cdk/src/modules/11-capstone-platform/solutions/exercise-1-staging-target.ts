import * as pipelines from 'aws-cdk-lib/pipelines';
import { ENVIRONMENTS, EnvironmentTier } from '@cdk-mastery/shared';
import { PlatformTarget } from '../config';

/**
 * Exercise 1 — a third tier with no code changes to any stack.
 *
 * `staging` in the shared model is "prod-shaped but disposable": highly
 * available (3 AZs, 3 NAT gateways, PITR on) yet `retainStatefulResources:
 * false` and `requiresApproval: false`. Binding it to an account/region is one
 * table entry; every stack already reads `sizingFor(tier)` and
 * `removalPolicyFor(tier)`, so the shape follows.
 */
export const STAGING_TARGET: PlatformTarget = {
  tier: ENVIRONMENTS.staging,
  env: { account: '111111111111', region: 'us-east-2' },
};

/**
 * The approval gate is a *tier* property, not a pipeline constant. Staging has
 * none; prod has one. Any future tier gets the right gate for free.
 */
export function approvalStepsFor(tier: EnvironmentTier): pipelines.Step[] {
  return tier.requiresApproval
    ? [new pipelines.ManualApprovalStep(`PromoteTo${capitalize(tier.name)}`, { comment: `Approve deployment to ${tier.name}` })]
    : [];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
