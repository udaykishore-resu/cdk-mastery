import * as cdk from 'aws-cdk-lib';
import { regionShortCode, resourceName } from '@cdk-mastery/shared';
import { Construct } from 'constructs';
import { GlobalStack } from './global-stack';
import { RegionalStack } from './regional-stack';
import { platformSynthesizer } from './synthesizer';
import { DeploymentTarget } from './targets';

export interface PlatformStageProps extends cdk.StageProps {
  readonly target: DeploymentTarget;
}

/**
 * One Stage per DeploymentTarget. Instantiated twice by `index.ts` (dev, prod)
 * and by a pipeline in the capstone; the *same class* yields different stack
 * sets because the target says whether a global region exists.
 *
 * Stack naming: the construct id (`Regional`) is what `cdk ls` shows in the
 * hierarchical id (`M09-Prod/Regional`); `stackName` is what CloudFormation
 * shows (`revan-platform-prod-regional-usw2`). Set `stackName` explicitly when
 * humans will read the console or when the name must encode the region — the
 * default `<StageName>-<Id>` is fine for pipelines and terrible for on-call.
 *
 * Cross-region references: passing `global.webAclArn` (a token from a us-east-1
 * stack) into a us-west-2 stack makes CDK generate:
 *   - producer (us-east-1): `Custom::CrossRegionExportWriter`, a Lambda-backed
 *     custom resource that writes the value to an SSM parameter
 *     `/cdk/exports/<consumer stack>/<export name>` **in the consumer's region**;
 *   - consumer (us-west-2): `Custom::CrossRegionExportReader` that reads those
 *     parameters and exposes them via `Fn::GetAtt`, plus a dependency so the
 *     reader runs after the writer.
 * That is the "strong" mode (the default without context). With the feature
 * flag `@aws-cdk/core:defaultCrossStackReferences = "weak"` (set in this repo's
 * cdk.json) CDK instead emits a plain Output on the producer and the newer
 * `Fn::GetStackOutput` intrinsic on the consumer — no Lambdas, no SSM, but the
 * producer can be deleted while consumers still exist. The tests cover both.
 *
 * In 2.269 this wiring is automatic for any reference. The `crossRegionReferences`
 * stack prop still matters for one case: the name/ARN attributes of L2
 * `Resource`s (`bucket.bucketArn`, `table.tableName`, …). Across environments those
 * fall back to the resource's *physical name* unless the prop is `true` on both
 * stacks — and with no explicit physical name that fallback is a synth error.
 * Set it on every stack that takes part in a cross-region reference.
 */
export class PlatformStage extends cdk.Stage {
  readonly target: DeploymentTarget;
  readonly global?: GlobalStack;
  readonly regional: RegionalStack;

  constructor(scope: Construct, id: string, props: PlatformStageProps) {
    super(scope, id, { ...props, env: props.target.env });
    this.target = props.target;
    const { tier, env, globalRegion } = props.target;
    const synthesizer = () => platformSynthesizer(tier);

    if (globalRegion) {
      this.global = new GlobalStack(this, 'Global', {
        tier,
        env: { account: env.account, region: globalRegion },
        stackName: resourceName({ org: 'revan', service: 'platform', env: tier.name, component: 'global', region: regionShortCode(globalRegion) }),
        synthesizer: synthesizer(),
        crossRegionReferences: true,
        description: `Global (us-east-1) resources for the ${tier.name} platform`,
      });
    }

    this.regional = new RegionalStack(this, 'Regional', {
      target: props.target,
      env, // stacks inherit the Stage env anyway; explicit is clearer and lets the assertion in RegionalStack run
      stackName: resourceName({ org: 'revan', service: 'platform', env: tier.name, component: 'regional', region: regionShortCode(env.region) }),
      synthesizer: synthesizer(),
      crossRegionReferences: true,
      edgeWebAclArn: this.global?.webAclArn,
      edgeLogsBucketArn: this.global?.edgeLogsBucket.bucketArn,
      description: `Regional workload resources for the ${tier.name} platform in ${env.region}`,
    });
  }
}
