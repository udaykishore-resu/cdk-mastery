import * as cdk from 'aws-cdk-lib';
import { GitHubOidcStack } from './github-oidc-stack';
import { PipelineStack } from './pipeline-stack';

export * from './app-stage';
export * from './github-oidc-stack';
export * from './pipeline-stack';

/**
 * Module 08 entry point.
 *
 * Both stacks need a concrete env: `pipelines.CodePipeline` refuses to synthesize
 * env-agnostic (it must know the account/region to build cross-account trust and
 * asset publishing roles), and the OIDC role ARN pattern needs the partition.
 * The env comes from cdk.json context (`cdk-mastery:account` / `cdk-mastery:region`).
 *
 * Stages inside the pipeline stack show up in `cdk ls` as
 *   M08-Pipeline/Dev/Queue, M08-Pipeline/Dev/Function, M08-Pipeline/ProdUsw2/…, M08-Pipeline/ProdEuw1/…
 * — they are synthesized as nested assemblies and deployed by the pipeline, not by you.
 */
export function addToApp(app: cdk.App): void {
  const account = String(app.node.tryGetContext('cdk-mastery:account') ?? '111111111111');
  const region = String(app.node.tryGetContext('cdk-mastery:region') ?? 'us-east-1');
  const env = { account, region };
  const repo = String(app.node.tryGetContext('cdk-mastery:repo') ?? 'revan/cdk-mastery');

  new PipelineStack(app, 'M08-Pipeline', {
    env,
    repo,
    branch: 'main',
    // A real ARN comes from context; the placeholder keeps synth working offline.
    connectionArn:
      app.node.tryGetContext('cdk-mastery:connectionArn') ??
      `arn:aws:codeconnections:${region}:${account}:connection/00000000-0000-0000-0000-000000000000`,
    devEnv: env,
    prodAccount: '222222222222',
    prodRegions: ['us-west-2', 'eu-west-1'],
  });

  new GitHubOidcStack(app, 'M08-GitHubOidc', {
    env,
    repo,
    deployBranches: ['main'],
    deployEnvironments: ['prod'],
  });
}
