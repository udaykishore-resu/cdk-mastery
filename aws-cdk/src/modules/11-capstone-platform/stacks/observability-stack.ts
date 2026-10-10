import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { EnvironmentTier, resourceName } from '@cdk-mastery/shared';
import { Construct } from 'constructs';
import { ORG, SERVICE, sizingFor } from '../config';

export interface ObservabilityStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
  readonly api: apigw.IHttpApi;
  readonly apiHandler: lambda.IFunction;
  readonly worker: lambda.IFunction;
  readonly queue: sqs.IQueue;
  readonly deadLetterQueue: sqs.IQueue;
  readonly key: kms.IKey;
  /** Email for the alarm topic; the tier's `owner` is used as the fallback subscription target name. */
  readonly alarmEmail?: string;
}

/**
 * Alarms, a composite "the platform is unhealthy" alarm, a topic, a dashboard.
 *
 * The composite alarm is the one that pages. Individual alarms describe *what*
 * is wrong (5xx, worker errors, DLQ depth, queue age); the composite says
 * *whether a human is needed now* — any of the customer-facing signals, or the
 * DLQ filling up. Paging on individual alarms produces four pages for one
 * incident; paging on the composite produces one, with the dashboard showing
 * which components lit up.
 *
 * Deployed last in the Stage because it references everything else; it can be
 * changed and redeployed without touching any workload stack.
 */
export class ObservabilityStack extends cdk.Stack {
  readonly topic: sns.Topic;
  readonly platformUnhealthy: cloudwatch.CompositeAlarm;
  readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const { tier } = props;
    const periods = sizingFor(tier).alarmEvaluationPeriods;
    const period = cdk.Duration.minutes(1);

    this.topic = new sns.Topic(this, 'Alarms', {
      topicName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'alarms' }),
      displayName: `Orders ${tier.name} alarms`,
      masterKey: props.key, // AwsSolutions-SNS2; CloudWatch alarms can publish to KMS-encrypted topics
      enforceSSL: true,
    });
    if (props.alarmEmail) this.topic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));

    const api5xx = new cloudwatch.Alarm(this, 'Api5xx', {
      alarmName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'api-5xx' }),
      metric: props.api.metricServerError({ period, statistic: 'sum' }),
      threshold: 5,
      evaluationPeriods: periods,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'HTTP API returned >5 5xx responses per minute',
    });
    const apiLatency = new cloudwatch.Alarm(this, 'ApiLatencyP99', {
      alarmName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'api-latency' }),
      metric: props.api.metricLatency({ period, statistic: 'p99' }),
      threshold: 2000,
      evaluationPeriods: periods,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'HTTP API p99 latency above 2 s',
    });
    const workerErrors = new cloudwatch.Alarm(this, 'WorkerErrors', {
      alarmName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'worker-errors' }),
      metric: props.worker.metricErrors({ period, statistic: 'sum' }),
      threshold: 1,
      evaluationPeriods: periods,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const dlqDepth = new cloudwatch.Alarm(this, 'DlqNotEmpty', {
      alarmName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'dlq-depth' }),
      metric: props.deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period, statistic: 'max' }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1, // one poisoned message is already an incident
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const queueAge = new cloudwatch.Alarm(this, 'QueueBacklog', {
      alarmName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'queue-age' }),
      metric: props.queue.metricApproximateAgeOfOldestMessage({ period, statistic: 'max' }),
      threshold: 300,
      evaluationPeriods: periods,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Oldest message waited >5 min: the worker is not keeping up',
    });

    // Customer-facing OR data-loss-adjacent → page. Latency and backlog alone → dashboard only.
    this.platformUnhealthy = new cloudwatch.CompositeAlarm(this, 'PlatformUnhealthy', {
      compositeAlarmName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'unhealthy' }),
      alarmRule: cloudwatch.AlarmRule.anyOf(
        cloudwatch.AlarmRule.fromAlarm(api5xx, cloudwatch.AlarmState.ALARM),
        cloudwatch.AlarmRule.fromAlarm(workerErrors, cloudwatch.AlarmState.ALARM),
        cloudwatch.AlarmRule.fromAlarm(dlqDepth, cloudwatch.AlarmState.ALARM),
      ),
      alarmDescription: 'Orders platform needs a human: API 5xx, worker errors or poison messages',
    });
    this.platformUnhealthy.addAlarmAction(new actions.SnsAction(this.topic));
    this.platformUnhealthy.addOkAction(new actions.SnsAction(this.topic));

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'dashboard' }),
      defaultInterval: cdk.Duration.hours(3),
    });
    this.dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({ title: 'Alarms', alarms: [this.platformUnhealthy, api5xx, apiLatency, workerErrors, dlqDepth, queueAge], width: 24, height: 3 }),
      new cloudwatch.GraphWidget({ title: 'API requests', left: [props.api.metricCount({ period, statistic: 'sum' })], right: [props.api.metricServerError({ period, statistic: 'sum' }), props.api.metricClientError({ period, statistic: 'sum' })], width: 12 }),
      new cloudwatch.GraphWidget({ title: 'API latency', left: [props.api.metricLatency({ period, statistic: 'p50' }), props.api.metricLatency({ period, statistic: 'p99' })], width: 12 }),
      new cloudwatch.GraphWidget({ title: 'Lambda', left: [props.apiHandler.metricInvocations({ period }), props.worker.metricInvocations({ period })], right: [props.apiHandler.metricErrors({ period }), props.worker.metricErrors({ period }), props.worker.metricThrottles({ period })], width: 12 }),
      new cloudwatch.GraphWidget({ title: 'Queue', left: [props.queue.metricApproximateNumberOfMessagesVisible({ period }), props.deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period })], right: [props.queue.metricApproximateAgeOfOldestMessage({ period })], width: 12 }),
    );

    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: this.topic.topicArn });
  }
}
