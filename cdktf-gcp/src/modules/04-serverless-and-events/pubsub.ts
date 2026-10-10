import { Construct } from 'constructs';
import { PubsubTopic } from '@cdktf/provider-google/lib/pubsub-topic';
import { PubsubSubscription } from '@cdktf/provider-google/lib/pubsub-subscription';
import { PubsubTopicIamMember } from '@cdktf/provider-google/lib/pubsub-topic-iam-member';
import { PubsubSubscriptionIamMember } from '@cdktf/provider-google/lib/pubsub-subscription-iam-member';
import { EnvironmentTier, mandatoryTags } from '@cdk-mastery/shared';

export interface OrderTopicsProps {
  readonly tier: EnvironmentTier;
  /** Base name, e.g. `cdkm-events-dev-orders`. */
  readonly name: string;
  /** Project number (token is fine) — the Pub/Sub service agent principal is derived from it. */
  readonly projectNumber: string;
  /** Subscription filter; only matching messages are delivered (non-matching are acked and dropped). */
  readonly filter?: string;
}

/**
 * Topic + dead-letter topic + a pull subscription with the full reliability
 * surface, plus the two IAM grants that make dead-lettering actually work.
 *
 *   orders ──(sub: orders-worker)──▶ consumer
 *     │  5 failed attempts
 *     └──▶ orders-dead-letter ──(sub: orders-dead-letter-monitor)──▶ humans / alert
 *
 * Dead-lettering is done *by the Pub/Sub service agent*
 * (service-<project_number>@gcp-sa-pubsub.iam.gserviceaccount.com), not by
 * your consumer. Without `publisher` on the DLQ topic and `subscriber` on the
 * source subscription, Pub/Sub silently keeps redelivering forever and the
 * console shows a yellow "dead letter topic permissions" warning nobody reads.
 */
export class OrderTopics extends Construct {
  readonly topic: PubsubTopic;
  readonly deadLetterTopic: PubsubTopic;
  readonly subscription: PubsubSubscription;
  readonly deadLetterSubscription: PubsubSubscription;

  constructor(scope: Construct, id: string, props: OrderTopicsProps) {
    super(scope, id);
    const labels = mandatoryTags(props.tier, 'events');
    const pubsubAgent = `serviceAccount:service-${props.projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com`;

    this.topic = new PubsubTopic(this, 'Topic', {
      name: props.name,
      // Topic-level retention lets a *new* subscription seek back in time
      // (`seek` to a timestamp) and replays after a bad deploy. 7 days max.
      messageRetentionDuration: '604800s',
      labels,
    });

    this.deadLetterTopic = new PubsubTopic(this, 'DeadLetterTopic', {
      name: `${props.name}-dead-letter`,
      messageRetentionDuration: '604800s',
      labels: { ...labels, purpose: 'dead-letter' },
    });

    this.subscription = new PubsubSubscription(this, 'Worker', {
      name: `${props.name}-worker`,
      topic: this.topic.id,
      // Time the consumer has to ack before redelivery. Pull clients extend it
      // automatically (modAck); set it to your p99 processing time, not higher.
      ackDeadlineSeconds: 60,
      // Exponential backoff between redeliveries; without it, a poison message
      // is redelivered as fast as the consumer nacks it.
      retryPolicy: { minimumBackoff: '10s', maximumBackoff: '600s' },
      // After 5 delivery attempts (min 5, max 100) the message is forwarded to
      // the DLQ with its original attributes plus CloudPubSubDeadLetterSourceDeliveryCount etc.
      deadLetterPolicy: { deadLetterTopic: this.deadLetterTopic.id, maxDeliveryAttempts: 5 },
      // Only order events; a digest published by Scheduler on the same topic
      // is filtered out here at no cost to the consumer.
      filter: props.filter ?? 'attributes.type = "order.created"',
      // Ordering keys: in-order delivery per key (e.g. per order id); throughput per key is limited.
      enableMessageOrdering: true,
      // Never auto-delete the subscription because it was idle (default is 31 days!).
      expirationPolicy: { ttl: '' },
      // Retain acked messages for 7 days so `seek` can replay them.
      messageRetentionDuration: '604800s',
      retainAckedMessages: props.tier.highlyAvailable,
      labels,
    });

    this.deadLetterSubscription = new PubsubSubscription(this, 'DeadLetterMonitor', {
      name: `${props.name}-dead-letter-monitor`,
      topic: this.deadLetterTopic.id,
      ackDeadlineSeconds: 600,
      messageRetentionDuration: '604800s',
      expirationPolicy: { ttl: '' },
      labels: { ...labels, purpose: 'dead-letter' },
    });

    new PubsubTopicIamMember(this, 'AgentPublishesToDlq', {
      topic: this.deadLetterTopic.name,
      role: 'roles/pubsub.publisher',
      member: pubsubAgent,
    });
    new PubsubSubscriptionIamMember(this, 'AgentSubscribesSource', {
      subscription: this.subscription.name,
      role: 'roles/pubsub.subscriber',
      member: pubsubAgent,
    });
  }

  /** Additive grant: `member` may publish to the main topic. */
  grantPublish(id: string, member: string): PubsubTopicIamMember {
    return new PubsubTopicIamMember(this, id, { topic: this.topic.name, role: 'roles/pubsub.publisher', member });
  }

  /** Additive grant: `member` may pull from the worker subscription. */
  grantSubscribe(id: string, member: string): PubsubSubscriptionIamMember {
    return new PubsubSubscriptionIamMember(this, id, { subscription: this.subscription.name, role: 'roles/pubsub.subscriber', member });
  }
}
