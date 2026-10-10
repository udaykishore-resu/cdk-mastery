import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as pipelines from 'aws-cdk-lib/pipelines';
import { ENVIRONMENTS, regionShortCode, resourceName } from '@cdk-mastery/shared';
import { Construct } from 'constructs';
import { AppStage } from './app-stage';

export interface PipelineStackProps extends cdk.StackProps {
  /** `owner/repo` on GitHub (or Bitbucket/GitLab via CodeConnections). */
  readonly repo: string;
  readonly branch: string;
  /**
   * ARN of a CodeConnections connection created *once, by hand* in the console
   * (the OAuth handshake cannot be automated). Stored in context/SSM, never in code.
   */
  readonly connectionArn: string;
  /** Where the dev stage deploys. Same account as the pipeline in this module. */
  readonly devEnv: Required<cdk.Environment>;
  /** Prod account; one AppStage per region is deployed in parallel as a Wave. */
  readonly prodAccount: string;
  readonly prodRegions: string[];
}

/**
 * A self-mutating CDK pipeline.
 *
 * Shape of the generated CodePipeline (stage names are what tests assert on):
 *
 *   Source → Build (Synth) → UpdatePipeline (SelfMutate) → Assets → Dev → Prod
 *
 * - Synth runs `npm ci && npx cdk synth` and hands `aws-cdk/cdk.out` (the cloud
 *   assembly) to every later action. Nothing downstream runs TypeScript.
 * - UpdatePipeline diffs the pipeline's *own* stack in the fresh assembly against
 *   itself and, if it changed, deploys it and restarts. That is "self-mutation":
 *   adding a stage in code and pushing is all it takes; you never `cdk deploy`
 *   the pipeline again after the first time.
 * - Assets publishes every file/Docker asset in the assembly (with `cdk-assets`)
 *   to the bootstrap buckets/ECR repos of each target env before any stack that
 *   references them deploys.
 * - Dev/Prod are Stages; each stack becomes Prepare (change set) + Deploy actions
 *   ordered by the assembly's dependency graph.
 */
export class PipelineStack extends cdk.Stack {
  readonly pipeline: pipelines.CodePipeline;
  readonly dev: AppStage;
  readonly prod: AppStage[] = [];

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const source = pipelines.CodePipelineSource.connection(props.repo, props.branch, {
      connectionArn: props.connectionArn,
      triggerOnPush: true, // false = deploy only when the pipeline is started manually or by a schedule
    });

    this.pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: resourceName({ org: 'revan', service: 'orders', env: 'shared', component: 'pipeline' }),
      // V2 pipelines support variables, triggers with path filters and stage-level
      // conditions; V1 is legacy. The feature flag defaultPipelineTypeToV2 makes V2
      // the default under cdk.json, but a bare `new App()` (tests) would fall back
      // to V1 — be explicit so the template does not depend on context.
      pipelineType: codepipeline.PipelineType.V2,
      synth: new pipelines.ShellStep('Synth', {
        input: source,
        installCommands: ['npm ci'],
        commands: ['npx cdk synth --quiet'],
        // Monorepo: the CDK app lives in aws-cdk/, so is its cdk.out.
        primaryOutputDirectory: 'aws-cdk/cdk.out',
        env: { CI: 'true' },
      }),
      // No Docker assets in this app → no privileged mode for the synth project.
      // Turn on only if you use DockerImageAsset/bundling in Docker; it slows builds.
      dockerEnabledForSynth: false,
      // A KMS key for the artifact bucket is only needed when another account must
      // read artifacts (cross-account deploy actions). Same-account pipelines skip
      // the ~$1/month key and the key-policy plumbing.
      crossAccountKeys: props.devEnv.account !== props.prodAccount,
      // Self-mutation on. Set false only for a pipeline that is itself deployed by
      // another pipeline (rare) or during a migration where you must deploy the
      // pipeline stack from a laptop.
      selfMutation: true,
      // Change sets (default true) give a Prepare/Execute pair per stack so a
      // human or an automated gate can inspect the change set. They cost one
      // extra action per stack and ~30 s. Keep them; the module's GitHub Actions
      // alternative is where you would run without.
      useChangeSets: true,
      publishAssetsInParallel: true,
    });

    // --- Dev: same account as the pipeline. Unit tests gate it; a smoke test
    //     that reads a stack output proves the deployment did something.
    this.dev = new AppStage(this, 'Dev', { tier: ENVIRONMENTS.dev, env: props.devEnv });
    this.pipeline.addStage(this.dev, {
      pre: [
        new pipelines.ShellStep('UnitTests', {
          input: source,
          installCommands: ['npm ci'],
          commands: ['npm test -w aws-cdk -- --ci'],
        }),
      ],
      post: [
        new pipelines.ShellStep('SmokeTest', {
          // The value is a stack output; CDK wires it through CodePipeline's
          // variable namespace on the deploy action (#{Dev-Function.FunctionName}).
          envFromCfnOutputs: { FUNCTION_NAME: this.dev.functionStack.functionNameOutput },
          commands: [
            'aws lambda invoke --function-name "$FUNCTION_NAME" --payload \'{"Records":[]}\' --cli-binary-format raw-in-base64-out /tmp/out.json',
            'cat /tmp/out.json',
            'grep -q batchItemFailures /tmp/out.json',
          ],
        }),
      ],
    });

    // --- Prod: one manual gate, then every region in parallel.
    const prodWave = this.pipeline.addWave('Prod', {
      pre: [
        new pipelines.ManualApprovalStep('PromoteToProd', {
          comment: 'Dev smoke test passed. Approve to deploy the same assembly to all prod regions.',
        }),
      ],
    });
    for (const region of props.prodRegions) {
      const stage = new AppStage(this, `Prod${capitalize(regionShortCode(region))}`, {
        tier: ENVIRONMENTS.prod,
        env: { account: props.prodAccount, region },
      });
      this.prod.push(stage);
      prodWave.addStage(stage);
    }
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
