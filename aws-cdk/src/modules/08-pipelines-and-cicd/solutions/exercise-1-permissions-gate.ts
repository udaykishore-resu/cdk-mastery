import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as pipelines from 'aws-cdk-lib/pipelines';

/**
 * Exercise 1 — gate a stage on *security-impacting* changes only.
 *
 * `ManualApprovalStep` stops every deployment. `ConfirmPermissionsBroadening`
 * runs `cdk diff --security-only` for the stage inside a CodeBuild project and
 * inserts a manual approval **only if** the diff broadens IAM permissions or
 * security-group rules. Routine changes flow through; a new `iam:*` statement
 * pages a human (optionally through an SNS topic).
 *
 * It renders as two actions: `<id>.Check` (CodeBuild) and `<id>.Confirm`
 * (manual approval that reads the check's MESSAGE/LINK variables). Put it in
 * `pre` so it runs before any Prepare action of the stage.
 */
export function gatedStageOptions(stage: cdk.Stage, notificationTopic?: sns.ITopic): pipelines.AddStageOpts {
  return {
    pre: [new pipelines.ConfirmPermissionsBroadening('SecurityCheck', { stage, notificationTopic })],
  };
}
