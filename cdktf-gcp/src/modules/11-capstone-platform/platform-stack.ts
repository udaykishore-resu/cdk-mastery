import { Aspects, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { EnvironmentTier, PascalCaseIds, mandatoryTags, maxDepthRule, resourceName } from '@cdk-mastery/shared';
import { LabelsAspect } from '../06-aspects-labels-and-governance/labels-aspect';
import { NoPublicBucketsAspect } from '../06-aspects-labels-and-governance/no-public-buckets-aspect';
import { ConstructPolicyAspect } from '../06-aspects-labels-and-governance/policy-bridge';
import { RequireCmekAspect } from '../06-aspects-labels-and-governance/require-cmek-aspect';
import { StatefulProtectionAspect } from '../06-aspects-labels-and-governance/stateful-protection-aspect';
import { BackendConfig, configureBackend } from '../08-cicd-and-workload-identity/backend';

export const SERVICE = 'orders';
export const ORG = 'cdkm';

/** Everything every platform stack needs to know. Built once by `OrdersPlatform`. */
export interface PlatformContext {
  readonly tier: EnvironmentTier;
  readonly project: string;
  readonly region: string;
  /** Resolved per stack id by the platform. */
  readonly backend: (stackId: string) => BackendConfig;
  /** Pin asset hashes (tests/snapshots); undefined in real deploys. */
  readonly assetHash?: string;
}

/**
 * Base class for the six platform stacks. It is where "governance at the
 * stack level" lives: provider, backend and the aspect set are decided here,
 * once, so no stack author can forget them. (`Aspects.of(app)` is a no-op in
 * cdktf 0.21 — see module 06 — which is why this is a base class and not an
 * app-level call.)
 */
export abstract class PlatformStack extends TerraformStack {
  readonly ctx: PlatformContext;
  readonly provider: GoogleProvider;

  constructor(scope: Construct, id: string, ctx: PlatformContext) {
    super(scope, id);
    this.ctx = ctx;
    this.provider = new GoogleProvider(this, 'Google', { project: ctx.project, region: ctx.region });
    configureBackend(this, ctx.backend(id));
    applyGovernance(this, ctx.tier);
  }

  /** `cdkm-orders-<env>-<component>` */
  protected name(component: string): string {
    return resourceName({ org: ORG, service: SERVICE, env: this.ctx.tier.name, component });
  }

  protected get labels(): Record<string, string> {
    return mandatoryTags(this.ctx.tier, SERVICE);
  }
}

/**
 * The governance set, in order (mutators first, validators after):
 *   LabelsAspect              every labelled resource gets mandatoryTags(tier, 'orders')
 *   StatefulProtectionAspect  prevent_destroy / deletion protection from the tier
 *   NoPublicBucketsAspect     always
 *   RequireCmekAspect         prod only: dev trades key control for cost and simplicity
 *   ConstructPolicyAspect     shared PascalCaseIds + a depth guard, via the module 06 bridge
 */
export function applyGovernance(stack: TerraformStack, tier: EnvironmentTier): void {
  const aspects = Aspects.of(stack);
  aspects.add(new LabelsAspect({ labels: mandatoryTags(tier, SERVICE) }));
  aspects.add(new StatefulProtectionAspect(tier));
  aspects.add(new NoPublicBucketsAspect());
  if (tier.name === 'prod') aspects.add(new RequireCmekAspect());
  aspects.add(new ConstructPolicyAspect([PascalCaseIds, maxDepthRule(6)]));
}
