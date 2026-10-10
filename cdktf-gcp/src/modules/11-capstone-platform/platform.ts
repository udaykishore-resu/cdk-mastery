import { App, TerraformStack } from 'cdktf';
import { EnvironmentTier } from '@cdk-mastery/shared';
import { BackendConfig, backendFromEnv } from '../08-cicd-and-workload-identity/backend';
import { gcpProject, gcpRegion } from './gcp-config';
import { PlatformContext } from './platform-stack';
import { ComputeStack } from './stacks/compute-stack';
import { DataStack } from './stacks/data-stack';
import { FoundationStack } from './stacks/foundation-stack';
import { MessagingStack } from './stacks/messaging-stack';
import { NetworkStack } from './stacks/network-stack';
import { ObservabilityStack } from './stacks/observability-stack';

export interface OrdersPlatformProps {
  readonly tier: EnvironmentTier;
  readonly project?: string;
  readonly region?: string;
  readonly github?: { readonly owner: string; readonly repo: string };
  readonly billingAccount?: string;
  readonly alertEmail?: string;
  /** Backend per stack id. Defaults to `backendFromEnv` (GCS when CDKM_STATE_BUCKET is set, else local). */
  readonly backend?: (stackId: string) => BackendConfig;
  /** Override the container image for the API. */
  readonly apiImage?: string;
  /** Pin asset hashes (tests). */
  readonly assetHash?: string;
}

/** Per-tier numbers that are policy, not code. Kept in one place so the README's cost table can cite them. */
export const TIER_SETTINGS: Record<string, { cidr: string; monthlyBudgetUsd: number }> = {
  dev: { cidr: '10.60.0.0/20', monthlyBudgetUsd: 150 },
  staging: { cidr: '10.61.0.0/20', monthlyBudgetUsd: 400 },
  prod: { cidr: '10.62.0.0/20', monthlyBudgetUsd: 1200 },
};

/**
 * The Orders platform: six stacks per environment, in dependency order.
 *
 *   m11-<env>-foundation    APIs, WIF + deployer, CMEK
 *   m11-<env>-network       VPC, subnet, NAT, Private Service Access
 *   m11-<env>-data          Cloud SQL (private, CMEK in prod), secret, BigQuery
 *   m11-<env>-messaging     topic, DLQ, subscriptions, service-agent IAM
 *   m11-<env>-compute       Cloud Run API, Functions worker (asset), Scheduler
 *   m11-<env>-observability alerts, uptime (prod), budget
 *
 * Every arrow between stacks is a cross-stack reference (an attribute read),
 * so `cdktf deploy` derives the order; `deployOrder` lists it for humans and
 * for the workflow's STACKS variable. Governance is applied in the
 * `PlatformStack` base class, per stack, because app-level aspects are a no-op.
 */
export class OrdersPlatform {
  readonly tier: EnvironmentTier;
  readonly foundation: FoundationStack;
  readonly network: NetworkStack;
  readonly data: DataStack;
  readonly messaging: MessagingStack;
  readonly compute: ComputeStack;
  readonly observability: ObservabilityStack;

  constructor(app: App, props: OrdersPlatformProps) {
    this.tier = props.tier;
    const env = props.tier.name;
    const settings = TIER_SETTINGS[env];
    const ctx: PlatformContext = {
      tier: props.tier,
      project: props.project ?? gcpProject(),
      region: props.region ?? gcpRegion(),
      backend: props.backend ?? ((stackId) => backendFromEnv(stackId)),
      assetHash: props.assetHash,
    };
    const stackId = (component: string) => `m11-${env}-${component}`;

    this.foundation = new FoundationStack(app, stackId('foundation'), {
      ctx,
      github: props.github ?? { owner: process.env.CDKM_GITHUB_OWNER ?? 'example-org', repo: process.env.CDKM_GITHUB_REPO ?? 'cdk-mastery' },
    });
    this.network = new NetworkStack(app, stackId('network'), { ctx, cidr: settings.cidr });
    this.data = new DataStack(app, stackId('data'), { ctx, foundation: this.foundation, network: this.network });
    this.messaging = new MessagingStack(app, stackId('messaging'), { ctx });
    this.compute = new ComputeStack(app, stackId('compute'), {
      ctx,
      foundation: this.foundation,
      network: this.network,
      data: this.data,
      messaging: this.messaging,
      apiImage: props.apiImage,
    });
    this.observability = new ObservabilityStack(app, stackId('observability'), {
      ctx,
      compute: this.compute,
      messaging: this.messaging,
      alertEmail: props.alertEmail ?? process.env.CDKM_ALERT_EMAIL ?? `${props.tier.owner}@example.com`,
      billingAccount: props.billingAccount ?? process.env.CDKM_BILLING_ACCOUNT ?? '000000-AAAAAA-BBBBBB',
      monthlyBudgetUsd: settings.monthlyBudgetUsd,
    });
  }

  /** Deploy order; teardown is the reverse. */
  get deployOrder(): TerraformStack[] {
    return [this.foundation, this.network, this.data, this.messaging, this.compute, this.observability];
  }

  get stackIds(): string[] {
    return this.deployOrder.map((s) => s.node.id);
  }
}
