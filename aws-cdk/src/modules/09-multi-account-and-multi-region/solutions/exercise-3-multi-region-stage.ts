import * as cdk from 'aws-cdk-lib';
import { regionShortCode, resourceName } from '@cdk-mastery/shared';
import { Construct } from 'constructs';
import { GlobalStack } from '../global-stack';
import { RegionalStack } from '../regional-stack';
import { platformSynthesizer } from '../synthesizer';
import { DeploymentTarget } from '../targets';

export interface MultiRegionStageProps extends cdk.StageProps {
  readonly target: DeploymentTarget;
  /** Additional regions; the target's own region is always the primary. */
  readonly replicaRegions: string[];
}

/**
 * Exercise 3 — fan a tier out across regions from one Stage.
 *
 * This is the in-CDK alternative to CloudFormation StackSets: N copies of the
 * regional stack, each with its own concrete env, a unique `stackName`
 * carrying the region short-code, and the tier's synthesizer/qualifier; one
 * global stack in us-east-1 whose WebACL ARN is referenced from *every* region
 * (N cross-region references, one writer, N readers).
 *
 * Why not StackSets? StackSets deploy one template to many targets *outside*
 * the CDK dependency graph — no cross-stack references into or out of the set,
 * no per-target customisation beyond parameters, and the pipeline cannot gate
 * per region. They shine for org-wide baselines (Config, GuardDuty, IAM roles)
 * owned by Control Tower; workload stacks belong in a Stage like this one.
 */
export class MultiRegionStage extends cdk.Stage {
  readonly global: GlobalStack;
  readonly regional: Map<string, RegionalStack> = new Map();

  constructor(scope: Construct, id: string, props: MultiRegionStageProps) {
    super(scope, id, { ...props, env: props.target.env });
    const { tier, env } = props.target;
    const regions = [env.region, ...props.replicaRegions];
    if (new Set(regions).size !== regions.length) throw new Error(`Duplicate regions: ${regions.join(', ')}`);

    this.global = new GlobalStack(this, 'Global', {
      tier,
      env: { account: env.account, region: 'us-east-1' },
      stackName: resourceName({ org: 'revan', service: 'platform', env: tier.name, component: 'global', region: 'use1' }),
      synthesizer: platformSynthesizer(tier),
      crossRegionReferences: true,
    });

    for (const region of regions) {
      const target: DeploymentTarget = { ...props.target, env: { account: env.account, region } };
      const stack = new RegionalStack(this, `Regional${capitalize(regionShortCode(region))}`, {
        target,
        env: target.env,
        stackName: resourceName({ org: 'revan', service: 'platform', env: tier.name, component: 'regional', region: regionShortCode(region) }),
        synthesizer: platformSynthesizer(tier),
        crossRegionReferences: true,
        edgeWebAclArn: this.global.webAclArn,
      });
      this.regional.set(region, stack);
    }
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
