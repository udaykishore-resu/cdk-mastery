/**
 * Environment model shared by both tracks.
 *
 * A "deployment environment" is a *business* concept (dev / staging / prod)
 * that both clouds map onto different *technical* concepts:
 *   - AWS CDK: an `Environment` is `{ account, region }`, and a `Stage` groups stacks.
 *   - CDKTF:   an environment is usually a separate `TerraformStack` (its own state file)
 *              targeting a project + region, or a Terraform workspace.
 *
 * Keeping the business definition here means the capstones in both tracks read
 * the same config and disagree only about how to *realise* it.
 */

export type EnvironmentName = 'dev' | 'staging' | 'prod';

export interface EnvironmentTier {
  /** Human name used in resource names and tags/labels. */
  readonly name: EnvironmentName;
  /** Whether stateful resources (databases, buckets) must survive `destroy`. */
  readonly retainStatefulResources: boolean;
  /** Whether a human must approve before deployment (pipeline gates). */
  readonly requiresApproval: boolean;
  /** Multi-AZ / regional-redundant deployments cost more; only prod pays for them by default. */
  readonly highlyAvailable: boolean;
  /** Default log retention, in days, for anything that emits logs. */
  readonly logRetentionDays: number;
  /** Who gets paged. Free-form so it can be an email, a PagerDuty key or a Slack channel. */
  readonly owner: string;
  /** Cost centre — every resource is labelled with this so FinOps can attribute spend. */
  readonly costCenter: string;
}

export const ENVIRONMENTS: Record<EnvironmentName, EnvironmentTier> = {
  dev: {
    name: 'dev',
    retainStatefulResources: false,
    requiresApproval: false,
    highlyAvailable: false,
    logRetentionDays: 7,
    owner: 'platform-team',
    costCenter: 'cc-platform-dev',
  },
  staging: {
    name: 'staging',
    retainStatefulResources: false,
    requiresApproval: false,
    highlyAvailable: true,
    logRetentionDays: 30,
    owner: 'platform-team',
    costCenter: 'cc-platform-staging',
  },
  prod: {
    name: 'prod',
    retainStatefulResources: true,
    requiresApproval: true,
    highlyAvailable: true,
    logRetentionDays: 365,
    owner: 'platform-oncall',
    costCenter: 'cc-platform-prod',
  },
};

export function environmentFor(name: string): EnvironmentTier {
  const tier = (ENVIRONMENTS as Record<string, EnvironmentTier>)[name];
  if (!tier) {
    throw new Error(`Unknown environment "${name}". Expected one of: ${Object.keys(ENVIRONMENTS).join(', ')}`);
  }
  return tier;
}

/**
 * The set of tags/labels every resource must carry, derived from the tier.
 * AWS calls them *tags* (case-sensitive keys, 128 chars); GCP calls them *labels*
 * (lowercase keys, `[a-z0-9_-]`, 63 chars). `normaliseLabelKey` bridges the two.
 */
export function mandatoryTags(tier: EnvironmentTier, service: string): Record<string, string> {
  return {
    environment: tier.name,
    service,
    owner: tier.owner,
    'cost-center': tier.costCenter,
    'managed-by': 'cdk-mastery',
  };
}
