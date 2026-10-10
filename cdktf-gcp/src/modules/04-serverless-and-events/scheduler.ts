import { Construct } from 'constructs';
import { ITerraformDependable } from 'cdktf';
import { CloudSchedulerJob } from '@cdktf/provider-google/lib/cloud-scheduler-job';
import { PubsubTopicIamMember } from '@cdktf/provider-google/lib/pubsub-topic-iam-member';
import { EnvironmentTier, resourceName } from '@cdk-mastery/shared';
import { OrderTopics } from './pubsub';

export interface DigestScheduleProps {
  readonly tier: EnvironmentTier;
  readonly region: string;
  readonly projectNumber: string;
  readonly topics: OrderTopics;
  /** Unix cron, evaluated in `timeZone`. Default: hourly. */
  readonly schedule?: string;
  readonly timeZone?: string;
  readonly dependsOn?: ITerraformDependable[];
}

/**
 * Cloud Scheduler → Pub/Sub. Scheduler publishes with the Cloud Scheduler
 * service agent (service-<project_number>@gcp-sa-cloudscheduler.iam.gserviceaccount.com);
 * for a topic in the same project the agent role already permits it, for a
 * topic in another project it does not. The explicit grant makes the
 * dependency visible and works in both cases.
 *
 * The published message carries `type = "digest"`, which the worker
 * subscription's filter (`attributes.type = "order.created"`) excludes — a
 * cheap way to multiplex a topic without a second consumer reading and
 * discarding.
 */
export class DigestSchedule extends Construct {
  readonly job: CloudSchedulerJob;

  constructor(scope: Construct, id: string, props: DigestScheduleProps) {
    super(scope, id);
    const schedulerAgent = `serviceAccount:service-${props.projectNumber}@gcp-sa-cloudscheduler.iam.gserviceaccount.com`;
    const publish = props.topics.grantPublish('SchedulerPublishes', schedulerAgent);

    this.job = new CloudSchedulerJob(this, 'Job', {
      name: resourceName({ org: 'cdkm', service: 'events', env: props.tier.name, component: 'hourly-digest' }),
      region: props.region,
      description: 'Publishes a digest request every hour',
      schedule: props.schedule ?? '0 * * * *',
      timeZone: props.timeZone ?? 'Etc/UTC',
      // Deadline for the *publish* call, not for the consumer.
      attemptDeadline: '30s',
      retryConfig: { retryCount: 3, minBackoffDuration: '5s', maxBackoffDuration: '60s', maxDoublings: 3 },
      pubsubTarget: {
        topicName: props.topics.topic.id,
        // Pub/Sub data is bytes; the API wants base64. Attributes are plain strings.
        data: Buffer.from(JSON.stringify({ kind: 'digest', window: 'PT1H' })).toString('base64'),
        attributes: { type: 'digest', source: 'cloud-scheduler' },
      },
      dependsOn: [publish, ...(props.dependsOn ?? [])],
    });
  }
}
