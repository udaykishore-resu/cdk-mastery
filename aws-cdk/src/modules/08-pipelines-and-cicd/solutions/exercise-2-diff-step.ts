import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pipelines from 'aws-cdk-lib/pipelines';

export interface DiffStepProps {
  /** The Stage whose stacks are diffed (its hierarchical id selects them: `Dev/**`). */
  readonly stage: cdk.Stage;
  /** Bootstrap qualifier of the target environment(s). */
  readonly qualifier?: string;
  /** Fail the step (and stop the pipeline) when the diff is non-empty. */
  readonly failOnDiff?: boolean;
}

/**
 * Exercise 2 — a `cdk diff` step inside the pipeline.
 *
 * Why a `CodeBuildStep` and not a `ShellStep`? Because `cdk diff` must call
 * `cloudformation:GetTemplate`/`DescribeStacks` in the *target* account, which
 * it does by assuming the bootstrap **lookup** role (and the deploy role for
 * reading templates). A ShellStep runs with a project role that can assume
 * nothing; `CodeBuildStep.rolePolicyStatements` is the hook to grant
 * `sts:AssumeRole` on exactly those roles. This mirrors what
 * `ConfirmPermissionsBroadening` does internally.
 *
 * The step has no `input`, so it receives the cloud assembly (primary output of
 * the synth step) and runs the CLI with `--app <assembly dir>` — no TypeScript,
 * no `npm ci`, just the pinned `aws-cdk` CLI on top of a rendered assembly.
 */
export function cdkDiffStep(props: DiffStepProps): pipelines.CodeBuildStep {
  const qualifier = props.qualifier ?? cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER;
  const stagePath = props.stage.node.path; // e.g. "Dev" → stacks "Dev/Queue", "Dev/Function"
  return new pipelines.CodeBuildStep('Diff', {
    installCommands: ['npm install -g aws-cdk@2'],
    commands: [`cdk diff --app . '${stagePath}/**' ${props.failOnDiff ? '--fail' : ''}`.trim()],
    rolePolicyStatements: [
      new iam.PolicyStatement({
        sid: 'AssumeLookupAndDeployRoles',
        actions: ['sts:AssumeRole'],
        resources: [`arn:${cdk.Aws.PARTITION}:iam::*:role/cdk-${qualifier}-*-role-*`],
        conditions: { StringEquals: { 'iam:ResourceTag/aws-cdk:bootstrap-role': ['lookup', 'deploy'] } },
      }),
    ],
  });
}
