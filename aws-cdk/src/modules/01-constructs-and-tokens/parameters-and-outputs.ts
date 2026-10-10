import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * CloudFormation Parameters, Outputs and CDK Annotations.
 *
 * CfnParameter is supported but discouraged, and the reason is structural: a parameter's
 * value only exists at deploy time. CDK therefore
 *   - cannot branch on it (`if (param.valueAsString === 'prod')` compares a token),
 *   - cannot use it in a construct id or a logical ID,
 *   - cannot show it in `cdk diff` (the diff sees `{ Ref: 'Tier' }` on both sides),
 *   - cannot validate it in unit tests, and
 *   - loses the "one template == one deployable artefact" property that makes pipelines
 *     reproducible: the same `cdk.out` can now deploy N different things.
 * The CDK-native replacement is *synth-time configuration*: props, context
 * (`node.tryGetContext`), environment config objects (the shared `ENVIRONMENTS`), and a
 * separate stack per environment. Parameters remain the right tool exactly when the value
 * genuinely must be supplied by the *deployer*, not the author — e.g. a template shared
 * with teams that do not run your code (AWS Service Catalog products), or values that
 * must never touch source control and are not secrets-manager-able.
 */
export interface ParametersStackProps extends cdk.StackProps {
  readonly tier: string;
  /** Set to true to demonstrate an error annotation that fails synthesis. */
  readonly simulateMisconfiguration?: boolean;
}

export class ParametersStack extends cdk.Stack {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: ParametersStackProps) {
    super(scope, id, props);

    // The deployer-supplied value pattern. `valueAsString` is a token (`{ Ref: 'AlertEmail' }`).
    const alertEmail = new cdk.CfnParameter(this, 'AlertEmail', {
      type: 'String',
      description: 'Where alarms for this stack are delivered. Supplied at deploy time by the on-call lead.',
      allowedPattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
      constraintDescription: 'must be an email address',
    });

    this.topic = new sns.Topic(this, 'Alerts', { topicName: `cdk-mastery-${props.tier}-alerts` });
    // CDK's SNS L2 wants a subscription object; the L1 shows the parameter flowing through.
    new sns.CfnSubscription(this, 'EmailSubscription', {
      topicArn: this.topic.topicArn,
      protocol: 'email',
      endpoint: alertEmail.valueAsString,
    });

    // The synth-time configuration pattern, for contrast: the same fact read from context.
    // `cdk deploy -c cdk-mastery:alertEmail=x@y.z` or cdk.json; testable, diffable.
    const contextEmail = this.node.tryGetContext('cdk-mastery:alertEmail') ?? 'platform-team@example.com';
    new ssm.StringParameter(this, 'ContextEmail', {
      parameterName: `/cdk-mastery/${props.tier}/alert-email`,
      stringValue: contextEmail,
    });

    // Outputs: values other stacks, humans or scripts read after deploy. `exportName` makes
    // the output a cross-stack Export (module 02 explains why you rarely write that by hand).
    new cdk.CfnOutput(this, 'TopicArn', {
      value: this.topic.topicArn,
      description: 'ARN of the alerts topic',
      exportName: `cdk-mastery-${props.tier}-alerts-topic-arn`,
    });

    // Annotations attach messages to a construct path. They land in <stack>.metadata.json
    // and the CLI prints them after synth; errors fail `cdk synth`/`cdk deploy`.
    cdk.Annotations.of(this.topic).addInfoV2('cdk-mastery:ParametersStack.topicInfo', 'Alerts topic uses an email subscription; consider a chat integration for prod.');
    if (props.tier === 'dev') {
      cdk.Annotations.of(this).addWarningV2(
        'cdk-mastery:ParametersStack.devParameters',
        'This stack uses a CfnParameter; prefer context or props unless the value must come from the deployer.',
      );
    }
    if (props.simulateMisconfiguration) {
      // `Validations.of(scope).addError(id, message)` is the newer, id-carrying form; it
      // delegates to `Annotations.addError` under the hood and fails synthesis the same way.
      cdk.Validations.of(this).addError('cdk-mastery:ParametersStack.misconfigured', 'simulateMisconfiguration was set');
    }
  }
}
