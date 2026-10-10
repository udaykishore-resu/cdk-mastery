import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cfninc from 'aws-cdk-lib/cloudformation-include';
import { Construct } from 'constructs';

export interface CfnIncludeStackProps extends cdk.StackProps {
  /** Value for the legacy template's `Environment` parameter; baked in at synth time. */
  readonly environment: 'dev' | 'staging' | 'prod';
}

/**
 * Adopting a legacy template with `cloudformation-include`.
 *
 * `CfnInclude` parses `legacy-template.json` and turns every element into a
 * real L1 construct (`CfnQueue`, `CfnTopic`, `CfnParameter`, `CfnCondition`,
 * `CfnOutput`) **with its original logical ID preserved**. That is the whole
 * value: deploy this stack *over* the existing CloudFormation stack (same stack
 * name) and CloudFormation sees no changes — the resources are adopted, not
 * replaced. From then on, CDK code can reference them, override them, and
 * gradually replace them with L2s.
 *
 * `parameters` replaces a template Parameter with a literal at synth time: the
 * Parameter disappears from the template and every `Ref` to it becomes the value.
 * Leave parameters out to keep them as deploy-time inputs.
 */
export class CfnIncludeStack extends cdk.Stack {
  readonly include: cfninc.CfnInclude;
  readonly legacyQueue: sqs.IQueue;
  readonly legacyTopic: sns.ITopic;
  readonly consumer: lambda.Function;

  constructor(scope: Construct, id: string, props: CfnIncludeStackProps) {
    super(scope, id, props);

    this.include = new cfninc.CfnInclude(this, 'Legacy', {
      templateFile: path.join(__dirname, 'legacy-template.json'),
      parameters: { Environment: props.environment },
      preserveLogicalIds: true, // the default; stated because it is the point
    });

    // Typed access to included elements. The cast is safe: the type is fixed by the template.
    const cfnQueue = this.include.getResource('OrdersQueue') as sqs.CfnQueue;
    const cfnTopic = this.include.getResource('OrdersTopic') as sns.CfnTopic;
    const retention = this.include.getParameter('MessageRetentionSeconds');
    const queueUrlOutput = this.include.getOutput('QueueUrl');

    // Bridge L1 → L2 interface so the rest of the app uses grant*/metric* APIs.
    // `fromQueueAttributes` creates no resource; it wraps the ARN/URL tokens.
    this.legacyQueue = sqs.Queue.fromQueueAttributes(this, 'LegacyQueue', { queueArn: cfnQueue.attrArn, queueUrl: cfnQueue.ref });
    this.legacyTopic = sns.Topic.fromTopicArn(this, 'LegacyTopic', cfnTopic.ref);

    // New CDK-native consumer wired to the adopted queue.
    this.consumer = new lambda.Function(this, 'Consumer', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async (e) => ({ processed: (e.Records ?? []).length });'),
      timeout: cdk.Duration.seconds(30),
      environment: { QUEUE_URL: cfnQueue.ref, TOPIC_ARN: cfnTopic.ref, RETENTION: retention.valueAsString },
    });
    this.consumer.addEventSource(new eventsources.SqsEventSource(this.legacyQueue, { batchSize: 5 }));

    // Included resources are ordinary L1s: escape hatches apply as usual.
    cfnQueue.addPropertyOverride('SqsManagedSseEnabled', true);

    // Baking `Environment` in makes the template's `IsProd` condition constant, which
    // the built-in CloudFormation validator flags (W8003). That is intended here —
    // one synthesized template per environment — so acknowledge it with the reason.
    cdk.Validations.of(this).acknowledge({
      id: 'CloudFormation-Validate::W8003',
      reason: 'Environment is resolved at synth time on purpose; the IsProd condition is constant per synthesized template.',
    });
    // Retag an included output without touching the legacy JSON.
    queueUrlOutput.description = 'URL of the orders inbox queue (now consumed by the CDK Consumer function)';
  }
}
