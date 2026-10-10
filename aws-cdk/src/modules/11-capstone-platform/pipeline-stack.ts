import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as pipelines from 'aws-cdk-lib/pipelines';
import { resourceName } from '@cdk-mastery/shared';
import { Construct } from 'constructs';
import { ORG, PLATFORM_TARGETS, PlatformTarget, SERVICE } from './config';
import { OrdersPlatformStage } from './orders-platform-stage';

export interface PipelineStackProps extends cdk.StackProps {
  readonly repo: string;
  readonly branch: string;
  readonly connectionArn: string;
  readonly targets?: { dev: PlatformTarget; prod: PlatformTarget };
  /** Id prefix for the stages inside the pipeline (`M11-Dev`, `M11-Prod`). */
  readonly stageIdPrefix?: string;
}

/**
 * Self-mutating pipeline: Source → Synth → SelfMutate → Assets → Dev → [approval] → Prod.
 *
 * The approval gate is not hard-coded; it comes from `tier.requiresApproval`,
 * so adding a `staging` target with `requiresApproval: false` would flow
 * straight through while prod keeps its gate. The gate is a `ManualApprovalStep`
 * on the stage's `pre`, after the dev smoke test has passed.
 */
export class PipelineStack extends cdk.Stack {
  readonly pipeline: pipelines.CodePipeline;
  readonly dev: OrdersPlatformStage;
  readonly prod: OrdersPlatformStage;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);
    const targets = props.targets ?? PLATFORM_TARGETS;
    const prefix = props.stageIdPrefix ?? 'M11';

    const source = pipelines.CodePipelineSource.connection(props.repo, props.branch, { connectionArn: props.connectionArn });

    this.pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: resourceName({ org: ORG, service: SERVICE, env: 'shared', component: 'pipeline' }),
      pipelineType: codepipeline.PipelineType.V2,
      synth: new pipelines.ShellStep('Synth', {
        input: source,
        installCommands: ['npm ci'],
        commands: ['npm test -w aws-cdk -- --ci', 'npx cdk synth --strict --quiet'],
        primaryOutputDirectory: 'aws-cdk/cdk.out',
      }),
      dockerEnabledForSynth: false,
      crossAccountKeys: targets.dev.env.account !== targets.prod.env.account,
      selfMutation: true,
      useChangeSets: true,
    });

    this.dev = new OrdersPlatformStage(this, `${prefix}-Dev`, { tier: targets.dev.tier, env: targets.dev.env });
    this.pipeline.addStage(this.dev, {
      post: [
        new pipelines.ShellStep('SmokeTest', {
          envFromCfnOutputs: { API_URL: this.dev.api.apiUrlOutput },
          commands: ['curl -fsS "${API_URL}health"', 'echo', 'curl -fsS -X POST "${API_URL}orders" -H "content-type: application/json" -d \'{"customerId":"smoke","items":[{"sku":"test","qty":1}]}\''],
        }),
      ],
    });

    this.prod = new OrdersPlatformStage(this, `${prefix}-Prod`, { tier: targets.prod.tier, env: targets.prod.env });
    this.pipeline.addStage(this.prod, {
      pre: targets.prod.tier.requiresApproval
        ? [new pipelines.ManualApprovalStep('PromoteToProd', { comment: 'Dev smoke test passed. Approve to deploy the same cloud assembly to production.' })]
        : [],
    });
  }
}
