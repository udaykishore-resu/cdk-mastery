/**
 * Exercise 3 — a dead-letter queue nobody watches is a black hole.
 *
 * Alert when anything reaches the DLQ. The metric to use is
 * `pubsub.googleapis.com/subscription/dead_letter_message_count`, which is
 * reported on the *source* subscription (the one with the dead-letter policy),
 * not on the DLQ subscription. A second, coarser signal is
 * `subscription/num_undelivered_messages` on the DLQ subscription itself —
 * useful because it stays high until somebody drains the queue.
 */
import { Construct } from 'constructs';
import { MonitoringAlertPolicy } from '@cdktf/provider-google/lib/monitoring-alert-policy';
import { MonitoringNotificationChannel } from '@cdktf/provider-google/lib/monitoring-notification-channel';
import { EnvironmentTier, mandatoryTags } from '@cdk-mastery/shared';
import { OrderTopics } from '../pubsub';

export interface DeadLetterAlertProps {
  readonly tier: EnvironmentTier;
  readonly topics: OrderTopics;
  /** Where to page. Email is the lowest common denominator; PagerDuty/Slack channels have their own `type`. */
  readonly email: string;
}

export class DeadLetterAlert extends Construct {
  readonly channel: MonitoringNotificationChannel;
  readonly policy: MonitoringAlertPolicy;

  constructor(scope: Construct, id: string, props: DeadLetterAlertProps) {
    super(scope, id);

    this.channel = new MonitoringNotificationChannel(this, 'Email', {
      displayName: `${props.tier.owner} (${props.tier.name})`,
      type: 'email',
      labels: { email_address: props.email },
    });

    this.policy = new MonitoringAlertPolicy(this, 'Policy', {
      displayName: `[${props.tier.name}] orders dead-letter queue is receiving messages`,
      combiner: 'OR',
      severity: props.tier.highlyAvailable ? 'CRITICAL' : 'WARNING',
      notificationChannels: [this.channel.name],
      userLabels: mandatoryTags(props.tier, 'events'),
      conditions: [
        {
          displayName: 'dead_letter_message_count > 0 for 5 minutes',
          conditionThreshold: {
            filter: [
              'resource.type = "pubsub_subscription"',
              `resource.labels.subscription_id = "${props.topics.subscription.name}"`,
              'metric.type = "pubsub.googleapis.com/subscription/dead_letter_message_count"',
            ].join(' AND '),
            comparison: 'COMPARISON_GT',
            thresholdValue: 0,
            duration: '300s',
            aggregations: [{ alignmentPeriod: '60s', perSeriesAligner: 'ALIGN_SUM' }],
            trigger: { count: 1 },
          },
        },
        {
          displayName: 'DLQ backlog not drained',
          conditionThreshold: {
            filter: [
              'resource.type = "pubsub_subscription"',
              `resource.labels.subscription_id = "${props.topics.deadLetterSubscription.name}"`,
              'metric.type = "pubsub.googleapis.com/subscription/num_undelivered_messages"',
            ].join(' AND '),
            comparison: 'COMPARISON_GT',
            thresholdValue: 0,
            duration: '3600s',
            aggregations: [{ alignmentPeriod: '300s', perSeriesAligner: 'ALIGN_MAX' }],
          },
        },
      ],
      alertStrategy: { autoClose: '86400s' },
      documentation: {
        mimeType: 'text/markdown',
        content: [
          '## Orders DLQ',
          `Pull with: gcloud pubsub subscriptions pull ${props.topics.deadLetterSubscription.name} --limit 10 --format=json`,
          'Inspect `CloudPubSubDeadLetterSourceDeliveryErrorMessage` in message attributes for the last failure.',
          'Replay: fix the consumer, then publish the messages back to the source topic and ack them here.',
        ].join('\n'),
      },
    });
  }
}
