import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

/**
 * Exercise 1 — weaken ONE reference while the rest stay strong.
 *
 * Scenario: `HubStack` exposes a topic and a queue. `SpokeStack` uses both. The app-wide
 * default is strong (bare App in tests) but the queue is about to be moved elsewhere, so
 * the reference to it must not create an Export the spoke would deadlock on.
 *
 * `Stack.consumeReference(value, strength)` wraps a single token so that this usage — and
 * only this usage — renders with the given strength. Contrast with
 * `CrossStackReferences.of(hub.queue).produce(WEAK)` (every consumer of the queue) and
 * `CrossStackReferences.of(spoke).consume(WEAK)` (every reference the spoke consumes).
 */
export class HubStack extends cdk.Stack {
  readonly topic: sns.Topic;
  readonly queue: sqs.Queue;
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    this.topic = new sns.Topic(this, 'Events');
    this.queue = new sqs.Queue(this, 'Audit', { enforceSSL: true });
  }
}

export interface SpokeStackProps extends cdk.StackProps {
  readonly hub: HubStack;
}

export class SpokeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SpokeStackProps) {
    super(scope, id, props);

    // Strong (default): Export + Fn::ImportValue.
    new cdk.CfnOutput(this, 'TopicArn', { value: props.hub.topic.topicArn });

    // Weak for this usage only: plain Output on the hub + Fn::GetStackOutput here.
    //
    // Limitation in 2.269.0: `consumeReference` only accepts a *raw* CfnReference. L2
    // ARN attributes (`queue.queueArn`, `bucket.bucketArn`, `topic.topicArn`) are wrapped
    // by `Resource.getResourceArnAttribute` for cross-environment support and are rejected
    // with `ConsumeReferenceRequiresResourceAttribute` — despite the docstring's example.
    // Non-ARN attributes (`queue.queueUrl`) and any L1 attribute (`attrArn`, `ref`) work.
    const auditL1 = props.hub.queue.node.defaultChild as sqs.CfnQueue;
    const weakQueueArn = cdk.Stack.consumeReference(auditL1.attrArn, cdk.ReferenceStrength.WEAK);
    new cdk.CfnOutput(this, 'AuditQueueArn', { value: weakQueueArn });

    // Same topic, different usage, still strong — a subscription created in the spoke.
    props.hub.topic.addSubscription(new subs.SqsSubscription(new sqs.Queue(this, 'Inbox', { enforceSSL: true })));
  }
}
