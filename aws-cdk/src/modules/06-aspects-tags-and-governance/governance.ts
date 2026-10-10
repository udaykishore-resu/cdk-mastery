import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { EnvironmentTier, PascalCaseIds, mandatoryTags, maxDepthRule } from '@cdk-mastery/shared';
import { IConstruct } from 'constructs';
import { ConstructPolicyAspect } from './aspects/construct-policy-aspect';
import { EnforceBucketEncryptionAspect } from './aspects/enforce-bucket-encryption-aspect';
import { LogRetentionAspect } from './aspects/log-retention-aspect';
import { NoPublicBucketsAspect } from './aspects/no-public-buckets-aspect';
import { RequireTagsAspect } from './aspects/require-tags-aspect';

export interface GovernanceProps {
  readonly tier: EnvironmentTier;
  /** Service name that ends up in the `service` tag. */
  readonly service: string;
  /** KMS key ARN for SSE-KMS on buckets; SSE-S3 when omitted. */
  readonly bucketKmsKeyArn?: string;
}

/** Retention days → the matching `RetentionDays` enum member (the enum values *are* days). */
export function retentionFromDays(days: number): logs.RetentionDays {
  const values = Object.values(logs.RetentionDays).filter((v): v is number => typeof v === 'number');
  if (values.includes(days)) return days as logs.RetentionDays;
  // Round up to the next allowed value so we never *shorten* below what the tier asked for.
  const next = values.filter((v) => v > days).sort((a, b) => a - b)[0];
  return (next ?? logs.RetentionDays.INFINITE) as logs.RetentionDays;
}

/**
 * The one function a platform team exports. Call it once, at the widest scope
 * you own (a Stage in the capstone, a Stack here), and every construct beneath —
 * including ones from libraries you do not control — is tagged, hardened and
 * validated in a deterministic order:
 *
 *   MUTATING (200) : Tags, EnforceBucketEncryption, LogRetention
 *   DEFAULT  (500) : (nothing here; this is where un-prioritised aspects land)
 *   READONLY (1000): NoPublicBuckets, RequireTags, ConstructPolicy (PascalCaseIds)
 *
 * Validators must run last so they judge the tree *after* the mutators fixed it.
 * `Tags.of()` is also an aspect; with `@aws-cdk/core:aspectPrioritiesMutating`
 * it is registered at MUTATING, otherwise DEFAULT — both are below READONLY, so
 * `RequireTagsAspect` always sees the final tag set.
 */
export function applyGovernance(scope: IConstruct, props: GovernanceProps): void {
  // --- Tags -----------------------------------------------------------------
  // `Tags.of(scope).add` registers a Tag aspect on `scope`; every taggable L1 in
  // the subtree inherits it. A tag added closer to the resource, or with a higher
  // `priority`, wins — that is how a team overrides `owner` on one stack without
  // fighting the platform default.
  for (const [key, value] of Object.entries(mandatoryTags(props.tier, props.service))) {
    cdk.Tags.of(scope).add(key, value);
  }
  // Resource-type scoping: a tag that is only meaningful on a subset of types.
  // Here: cost-allocation tag that S3 lifecycle tooling reads; no reason to
  // stamp it on IAM roles. `priority: 200` beats a plain `Tags.of().add` (100)
  // on the same key if someone lower in the tree tries to override it.
  cdk.Tags.of(scope).add('data-classification', 'internal', {
    includeResourceTypes: ['AWS::S3::Bucket', 'AWS::DynamoDB::Table', 'AWS::DynamoDB::GlobalTable'],
    priority: 200,
  });

  // --- Mutating aspects -------------------------------------------------------
  cdk.Aspects.of(scope).add(new EnforceBucketEncryptionAspect({ kmsKeyArn: props.bucketKmsKeyArn }), {
    priority: cdk.AspectPriority.MUTATING,
  });
  cdk.Aspects.of(scope).add(
    new LogRetentionAspect({
      defaultRetention: retentionFromDays(props.tier.logRetentionDays),
      // Non-prod tiers get a ceiling: nobody keeps 365 days of dev logs on purpose.
      maxRetention: props.tier.name === 'prod' ? undefined : retentionFromDays(props.tier.logRetentionDays),
    }),
    { priority: cdk.AspectPriority.MUTATING },
  );

  // --- Read-only (validating) aspects -----------------------------------------
  cdk.Aspects.of(scope).add(new NoPublicBucketsAspect(), { priority: cdk.AspectPriority.READONLY });
  cdk.Aspects.of(scope).add(new RequireTagsAspect({ requiredKeys: ['environment', 'service', 'owner', 'cost-center'] }), {
    priority: cdk.AspectPriority.READONLY,
  });
  // The root's own id (`M06-Governed`, a stack *name*) is the caller's business; everything beneath is ours.
  cdk.Aspects.of(scope).add(
    new ConstructPolicyAspect([PascalCaseIds, maxDepthRule(12)], { exclude: (node) => node === scope }),
    { priority: cdk.AspectPriority.READONLY },
  );
}
