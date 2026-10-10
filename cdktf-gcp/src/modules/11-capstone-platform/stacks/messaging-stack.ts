import { TerraformOutput } from 'cdktf';
import { Construct } from 'constructs';
import { DataGoogleProject } from '@cdktf/provider-google/lib/data-google-project';
import { PubsubSubscription } from '@cdktf/provider-google/lib/pubsub-subscription';
import { PubsubSubscriptionIamMember } from '@cdktf/provider-google/lib/pubsub-subscription-iam-member';
import { PubsubTopic } from '@cdktf/provider-google/lib/pubsub-topic';
import { PubsubTopicIamMember } from '@cdktf/provider-google/lib/pubsub-topic-iam-member';
import { PlatformContext, PlatformStack } from '../platform-stack';

export interface MessagingStackProps {
  readonly ctx: PlatformContext;
}

/**
 * `m11-<env>-messaging`: the order-events topic, a dead-letter topic, the
 * worker's pull subscription with a dead-letter policy, and — the part people
 * forget — a subscription *on the DLQ* so dead-lettered messages are retained
 * (a topic without subscribers drops messages), plus the Pub/Sub service
 * agent's rights to forward to the DLQ and to ack on the source subscription.
 *
 * The worker (compute stack) is triggered by Eventarc on `orders`, which
 * creates its own push subscription; `OrdersPull` here is for batch/replay
 * consumers and is what the DLQ policy is attached to for the demo.
 */
export class MessagingStack extends PlatformStack {
  readonly orders: PubsubTopic;
  readonly deadLetter: PubsubTopic;
  readonly ordersPull: PubsubSubscription;
  readonly deadLetterSub: PubsubSubscription;

  constructor(scope: Construct, id: string, props: MessagingStackProps) {
    super(scope, id, props.ctx);
    const { tier, project } = this.ctx;
    const current = new DataGoogleProject(this, 'Current', { projectId: project });
    const pubsubAgent = `serviceAccount:service-${current.number}@gcp-sa-pubsub.iam.gserviceaccount.com`;

    this.orders = new PubsubTopic(this, 'Orders', {
      name: this.name('orders'),
      messageRetentionDuration: tier.highlyAvailable ? '604800s' : '86400s',
      labels: this.labels,
    });
    this.deadLetter = new PubsubTopic(this, 'OrdersDlq', {
      name: this.name('orders-dlq'),
      messageRetentionDuration: '604800s',
      labels: this.labels,
    });

    this.ordersPull = new PubsubSubscription(this, 'OrdersPull', {
      name: this.name('orders-pull'),
      topic: this.orders.name,
      ackDeadlineSeconds: 60,
      messageRetentionDuration: '604800s',
      retryPolicy: { minimumBackoff: '10s', maximumBackoff: '600s' },
      deadLetterPolicy: { deadLetterTopic: this.deadLetter.id, maxDeliveryAttempts: 5 },
      expirationPolicy: { ttl: '' }, // never expire on inactivity
      labels: this.labels,
    });

    // Retain dead-lettered messages for a week so they can be inspected/replayed.
    this.deadLetterSub = new PubsubSubscription(this, 'OrdersDlqPull', {
      name: this.name('orders-dlq-pull'),
      topic: this.deadLetter.name,
      ackDeadlineSeconds: 600,
      messageRetentionDuration: '604800s',
      expirationPolicy: { ttl: '' },
      labels: this.labels,
    });

    // Without these two grants dead-lettering silently does nothing.
    new PubsubTopicIamMember(this, 'DlqPublisher', { topic: this.deadLetter.name, role: 'roles/pubsub.publisher', member: pubsubAgent });
    new PubsubSubscriptionIamMember(this, 'SourceSubscriber', { subscription: this.ordersPull.name, role: 'roles/pubsub.subscriber', member: pubsubAgent });

    new TerraformOutput(this, 'OrdersTopic', { value: this.orders.id });
    new TerraformOutput(this, 'DeadLetterSubscription', { value: this.deadLetterSub.name });
  }
}
