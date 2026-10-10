import { Construct } from 'constructs';
import { PubsubTopic } from '@cdktf/provider-google/lib/pubsub-topic';
import { PubsubSubscription } from '@cdktf/provider-google/lib/pubsub-subscription';
import { PubsubTopicIamMember } from '@cdktf/provider-google/lib/pubsub-topic-iam-member';
import { PubsubSubscriptionIamMember } from '@cdktf/provider-google/lib/pubsub-subscription-iam-member';
import { EnvironmentTier, mandatoryTags } from '@cdk-mastery/shared';

export interface PubSubPipelineProps {
  readonly tier: EnvironmentTier;
  readonly name: string;
  /** Project number, for the Pub/Sub service agent principal. A token is fine. */
  readonly projectNumber: string;
  /** 5..100. Default 5. */
  readonly maxDeliveryAttempts?: number;
  readonly ackDeadlineSeconds?: number;
  readonly filter?: string;
  readonly orderingEnabled?: boolean;
}

/**
 * Module 04's topic + DLQ + subscription + agent grants, generalised. The
 * `grant*` helpers are the API: consumers never touch `google_pubsub_*_iam_*`
 * resources directly, so the additive-vs-authoritative decision is made once,
 * here, and the grants live in the pipeline's scope.
 */
export class PubSubPipeline extends Construct {
  readonly topic: PubsubTopic;
  readonly deadLetterTopic: PubsubTopic;
  readonly subscription: PubsubSubscription;
  readonly deadLetterSubscription: PubsubSubscription;
  private grantCounter = 0;

  constructor(scope: Construct, id: string, props: PubSubPipelineProps) {
    super(scope, id);
    const attempts = props.maxDeliveryAttempts ?? 5;
    const ackDeadline = props.ackDeadlineSeconds ?? 60;
    const labels = mandatoryTags(props.tier, 'events');
    const agent = `serviceAccount:service-${props.projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com`;

    this.node.addValidation({
      validate: () => {
        const errors: string[] = [];
        if (!Number.isInteger(attempts) || attempts < 5 || attempts > 100) {
          errors.push(`maxDeliveryAttempts must be an integer in [5, 100], got ${attempts}`);
        }
        if (!Number.isInteger(ackDeadline) || ackDeadline < 10 || ackDeadline > 600) {
          errors.push(`ackDeadlineSeconds must be an integer in [10, 600], got ${ackDeadline}`);
        }
        return errors;
      },
    });

    this.topic = new PubsubTopic(this, 'Topic', { name: props.name, messageRetentionDuration: '604800s', labels });
    this.deadLetterTopic = new PubsubTopic(this, 'DeadLetterTopic', {
      name: `${props.name}-dead-letter`,
      messageRetentionDuration: '604800s',
      labels: { ...labels, purpose: 'dead-letter' },
    });
    this.subscription = new PubsubSubscription(this, 'Subscription', {
      name: `${props.name}-sub`,
      topic: this.topic.id,
      ackDeadlineSeconds: ackDeadline,
      retryPolicy: { minimumBackoff: '10s', maximumBackoff: '600s' },
      deadLetterPolicy: { deadLetterTopic: this.deadLetterTopic.id, maxDeliveryAttempts: attempts },
      filter: props.filter,
      enableMessageOrdering: props.orderingEnabled ?? false,
      expirationPolicy: { ttl: '' },
      labels,
    });
    this.deadLetterSubscription = new PubsubSubscription(this, 'DeadLetterSubscription', {
      name: `${props.name}-dead-letter-sub`,
      topic: this.deadLetterTopic.id,
      ackDeadlineSeconds: 600,
      expirationPolicy: { ttl: '' },
      labels: { ...labels, purpose: 'dead-letter' },
    });

    new PubsubTopicIamMember(this, 'AgentPublishesDlq', { topic: this.deadLetterTopic.name, role: 'roles/pubsub.publisher', member: agent });
    new PubsubSubscriptionIamMember(this, 'AgentSubscribesSource', { subscription: this.subscription.name, role: 'roles/pubsub.subscriber', member: agent });
  }

  /** Additive: `member` may publish to the topic. Ids are generated; pass your own to keep them stable across refactors. */
  grantPublish(member: string, id = `Publish${this.grantCounter++}`): PubsubTopicIamMember {
    return new PubsubTopicIamMember(this, id, { topic: this.topic.name, role: 'roles/pubsub.publisher', member });
  }

  /** Additive: `member` may pull from the subscription. */
  grantSubscribe(member: string, id = `Subscribe${this.grantCounter++}`): PubsubSubscriptionIamMember {
    return new PubsubSubscriptionIamMember(this, id, { subscription: this.subscription.name, role: 'roles/pubsub.subscriber', member });
  }
}
