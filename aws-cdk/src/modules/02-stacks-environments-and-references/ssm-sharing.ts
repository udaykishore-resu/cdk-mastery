import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvironmentTier } from '@cdk-mastery/shared';

/**
 * Sharing values through SSM Parameter Store instead of stack references.
 *
 * Cross-stack references (strong or weak) couple the stacks inside ONE app: CDK must
 * see both sides to wire them. When the producer is another team's app, another repo,
 * or deployed on a different cadence, publish the value under a well-known parameter
 * name and let consumers read it. No Export, no embrace, no shared codebase.
 *
 * Two ways to read:
 *   - `StringParameter.valueForStringParameter(scope, name)` → a CloudFormation
 *     *parameter* of type `AWS::SSM::Parameter::Value<String>`. Resolved by CloudFormation
 *     at deploy time; the template has `{ Ref: 'SsmParameterValue…' }`. Works in
 *     env-agnostic stacks. Cannot be inspected at synth; changes are invisible to `cdk diff`.
 *   - `StringParameter.valueFromLookup(scope, name)` → a *context lookup*. The CLI reads
 *     the value with the lookup role at synth time, caches it in cdk.context.json, and
 *     the template contains the literal. Needs a concrete env. Visible to `cdk diff`,
 *     usable in synth-time logic (branching, names) — and stale until you `cdk context
 *     --reset`. When the value is not cached, synth continues with
 *     `dummy-value-for-<name>` and records the key under `manifest.missing`, which is
 *     how the CLI knows to go and fetch it (`lookups.ts` shows the mechanics).
 *
 * Naming contract used here: `/cdk-mastery/<tier>/platform/<key>`.
 */
export function platformParameterName(tier: EnvironmentTier, key: string): string {
  return `/cdk-mastery/${tier.name}/platform/${key}`;
}

export interface PlatformStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
}

/** The "producer" side — imagine it lives in the platform team's repo. */
export class PlatformStack extends cdk.Stack {
  readonly deployRole: iam.Role;
  readonly parameters: Record<string, ssm.StringParameter> = {};

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    this.deployRole = new iam.Role(this, 'DeployRole', {
      assumedBy: new iam.AccountPrincipal(this.account),
      description: 'Role application stacks may assume; published via SSM',
    });

    this.publish(props.tier, 'deploy-role-arn', this.deployRole.roleArn);
    this.publish(props.tier, 'log-retention-days', `${props.tier.logRetentionDays}`);
  }

  private publish(tier: EnvironmentTier, key: string, value: string): void {
    this.parameters[key] = new ssm.StringParameter(this, `Param${key.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase())}`, {
      parameterName: platformParameterName(tier, key),
      stringValue: value,
      description: `cdk-mastery platform value "${key}" for ${tier.name}`,
    });
  }
}

export interface AppStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
  /**
   * Name of a CloudFormation Export created by a stack OUTSIDE this app (e.g. a hand-written
   * template). Consumed with `Fn.importValue` — the raw intrinsic, no CDK bookkeeping.
   */
  readonly externalAlertsTopicExportName?: string;
}

/** The "consumer" side: reads platform values by name at deploy time. */
export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    // Deploy-time read: template parameter of type AWS::SSM::Parameter::Value<String>.
    const deployRoleArn = ssm.StringParameter.valueForStringParameter(this, platformParameterName(props.tier, 'deploy-role-arn'));
    const role = iam.Role.fromRoleArn(this, 'PlatformDeployRole', deployRoleArn, { mutable: false });

    new iam.Policy(this, 'AssumePlatformRole', {
      statements: [new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [role.roleArn] })],
      roles: [new iam.Role(this, 'Worker', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') })],
    });

    // `Fn.importValue` for an Export that some non-CDK stack owns. CDK adds no dependency
    // and no validation: if the export does not exist, CloudFormation fails at deploy.
    if (props.externalAlertsTopicExportName) {
      new cdk.CfnOutput(this, 'AlertsTopicArn', { value: cdk.Fn.importValue(props.externalAlertsTopicExportName) });
    }
  }
}
