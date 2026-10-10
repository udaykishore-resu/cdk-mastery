import * as cdk from 'aws-cdk-lib';
import { ENVIRONMENTS, EnvironmentName, EnvironmentTier } from '@cdk-mastery/shared';

/** The service every name and tag in the platform derives from. */
export const SERVICE = 'orders';
export const ORG = 'revan';

export interface PlatformTarget {
  readonly tier: EnvironmentTier;
  readonly env: Required<cdk.Environment>;
}

/**
 * Where each tier lives. The pipeline account is the dev account: it hosts
 * `M11-Pipeline`, deploys Dev in place and Prod cross-account (prod must be
 * bootstrapped with `--trust 111111111111`).
 */
export const PLATFORM_TARGETS: Record<Exclude<EnvironmentName, 'staging'>, PlatformTarget> = {
  dev: { tier: ENVIRONMENTS.dev, env: { account: '111111111111', region: 'us-east-1' } },
  prod: { tier: ENVIRONMENTS.prod, env: { account: '222222222222', region: 'us-west-2' } },
};

export const PIPELINE_ENV: Required<cdk.Environment> = PLATFORM_TARGETS.dev.env;

/** Sizing knobs derived from the tier, in one place so the README's cost table can cite them. */
export interface TierSizing {
  readonly maxAzs: number;
  readonly natGateways: number;
  readonly apiMemoryMb: number;
  readonly workerMemoryMb: number;
  readonly workerReservedConcurrency?: number;
  readonly pointInTimeRecovery: boolean;
  readonly deletionProtection: boolean;
  readonly alarmEvaluationPeriods: number;
}

export function sizingFor(tier: EnvironmentTier): TierSizing {
  return tier.highlyAvailable
    ? {
        maxAzs: 3,
        natGateways: 3, // one per AZ: an AZ outage must not take egress down with it
        apiMemoryMb: 1024,
        workerMemoryMb: 1024,
        workerReservedConcurrency: 50, // protects the table and downstream systems from a poison flood
        pointInTimeRecovery: true,
        deletionProtection: true,
        alarmEvaluationPeriods: 3,
      }
    : {
        maxAzs: 2,
        natGateways: 1, // ~$32/month each; dev tolerates a single-AZ egress dependency
        apiMemoryMb: 512,
        workerMemoryMb: 512,
        workerReservedConcurrency: undefined,
        pointInTimeRecovery: false,
        deletionProtection: false,
        alarmEvaluationPeriods: 1,
      };
}

export function removalPolicyFor(tier: EnvironmentTier): cdk.RemovalPolicy {
  return tier.retainStatefulResources ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
}
