import * as cdk from 'aws-cdk-lib';
import { ENVIRONMENTS, EnvironmentName, EnvironmentTier } from '@cdk-mastery/shared';

/**
 * Stage × Environment.
 *
 * `EnvironmentTier` (shared) is the *business* definition of dev/staging/prod:
 * retention, approvals, HA, cost centre. It says nothing about AWS. A
 * `DeploymentTarget` binds one tier to the *technical* coordinates AWS needs:
 * an account, a primary region, and — for tiers that own global resources
 * (CloudFront/WAF/ACM for CloudFront, Route 53 health checks, IAM) — the
 * us-east-1 "global" region.
 *
 * Keeping the binding in one table is the whole point of the module: every
 * stack, synthesizer, bootstrap command and pipeline stage reads from here.
 */
export interface DeploymentTarget {
  readonly tier: EnvironmentTier;
  readonly env: Required<cdk.Environment>;
  /**
   * Region for global-scope resources. Only us-east-1 is valid for WAF WebACLs
   * with CLOUDFRONT scope and for ACM certificates used by CloudFront.
   * @default - no global stack for this target
   */
  readonly globalRegion?: 'us-east-1';
}

/** The static table. Real deployments override accounts through context (see `targetFor`). */
export const TARGETS: Record<EnvironmentName, DeploymentTarget> = {
  dev: {
    tier: ENVIRONMENTS.dev,
    env: { account: '111111111111', region: 'us-east-1' },
  },
  staging: {
    tier: ENVIRONMENTS.staging,
    env: { account: '111111111111', region: 'us-east-2' },
  },
  prod: {
    tier: ENVIRONMENTS.prod,
    env: { account: '222222222222', region: 'us-west-2' },
    globalRegion: 'us-east-1',
  },
};

/**
 * Resolve a target, letting context override the account/region so the same
 * code deploys to a sandbox (`-c cdk-mastery:prod-account=333333333333`) —
 * the pattern behind "one config drives everything". Context keys:
 *   cdk-mastery:<tier>-account, cdk-mastery:<tier>-region
 */
export function targetFor(name: EnvironmentName, scope?: cdk.App): DeploymentTarget {
  const base = TARGETS[name];
  if (!scope) return base;
  const account = scope.node.tryGetContext(`cdk-mastery:${name}-account`);
  const region = scope.node.tryGetContext(`cdk-mastery:${name}-region`);
  if (account === undefined && region === undefined) return base;
  return {
    ...base,
    env: { account: account !== undefined ? String(account) : base.env.account, region: region !== undefined ? String(region) : base.env.region },
  };
}

/** `aws://111111111111/us-east-1` — the form the cloud assembly manifest and `cdk bootstrap` use. */
export function envUri(env: Required<cdk.Environment>): string {
  return `aws://${env.account}/${env.region}`;
}
