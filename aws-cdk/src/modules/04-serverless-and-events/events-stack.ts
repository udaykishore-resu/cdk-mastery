import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvironmentTier } from '@cdk-mastery/shared';
import { bundlingFor, logRetentionFor } from './api-stack';

/**
 * EventBridge rule → SQS (with DLQ) → worker Lambda, plus an EventBridge Scheduler cron.
 *
 * Why a queue between the bus and the function: EventBridge → Lambda directly retries for
 * 24h with no visibility and no back-pressure. A queue gives you buffering, a dead-letter
 * queue with a known `maxReceiveCount`, batching, concurrency control and metrics you can
 * alarm on (age of oldest message, DLQ depth). Every asynchronous consumer of business
 * events should look like this.
 *
 * Timing contract (must hold or you get duplicate processing):
 *   queue.visibilityTimeout  >=  6 x function.timeout      (Lambda's documented minimum)
 *   dlq.retentionPeriod      >   time-to-notice + time-to-fix (14 days is the max)
 */
export interface EventsStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
  /** The orders table from ApiStack; the worker updates order status. */
  readonly table: dynamodb.ITableV2;
}

export class EventsStack extends cdk.Stack {
  readonly bus: events.EventBus;
  readonly rule: events.Rule;
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly worker: NodejsFunction;
  readonly schedule: scheduler.Schedule;
  readonly reporter: NodejsFunction;
  readonly dlqAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: EventsStackProps) {
    super(scope, id, props);
    const functionTimeout = cdk.Duration.seconds(30);

    // --- Bus and queues --------------------------------------------------------------------
    // A custom bus per domain keeps rules and permissions scoped; `default` is for AWS events.
    this.bus = new events.EventBus(this, 'OrdersBus', { eventBusName: `cdk-mastery-${props.tier.name}-orders` });

    this.deadLetterQueue = new sqs.Queue(this, 'OrderEventsDlq', {
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.queue = new sqs.Queue(this, 'OrderEvents', {
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(functionTimeout.toSeconds() * 6),
      retentionPeriod: cdk.Duration.days(4),
      // After 3 failed receives (i.e. 3 handler failures for this message) SQS moves it to the DLQ.
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 3 },
    });

    // --- Rule: bus → queue ---------------------------------------------------------------
    // The pattern is content-based: only OrderPlaced from our source. `targets.SqsQueue`
    // adds the queue policy that lets events.amazonaws.com SendMessage (scoped to this
    // rule's ARN with the `eventsTargetQueueSameAccount` flag from cdk.json).
    this.rule = new events.Rule(this, 'OrderPlaced', {
      eventBus: this.bus,
      description: 'Fan OrderPlaced events into the processing queue',
      eventPattern: {
        source: ['cdk-mastery.orders'],
        detailType: ['OrderPlaced'],
        detail: { total: [{ numeric: ['>', 0] }] },
      },
      targets: [
        new targets.SqsQueue(this.queue, {
          // If EventBridge itself cannot deliver to the queue (policy broken), park the event here.
          deadLetterQueue: this.deadLetterQueue,
          retryAttempts: 3,
          maxEventAge: cdk.Duration.hours(1),
        }),
      ],
    });

    // --- Worker ----------------------------------------------------------------------------
    this.worker = new NodejsFunction(this, 'Worker', {
      entry: path.join(__dirname, 'handlers', 'worker.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: functionTimeout,
      logGroup: new logs.LogGroup(this, 'WorkerLogs', { retention: logRetentionFor(props.tier), removalPolicy: cdk.RemovalPolicy.DESTROY }),
      loggingFormat: lambda.LoggingFormat.JSON,
      environment: { TABLE_NAME: props.table.tableName },
      bundling: bundlingFor(props.tier),
      // Cap concurrency so a burst cannot exhaust the account's pool or hammer DynamoDB.
      reservedConcurrentExecutions: props.tier.highlyAvailable ? 50 : 5,
    });
    // Least privilege: the worker only writes (UpdateItem is a write); no reads, no queries.
    props.table.grantWriteData(this.worker);

    this.worker.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: 10,
        // Wait up to 5 s to fill a batch: fewer invocations, lower cost, +5 s latency.
        maxBatchingWindow: cdk.Duration.seconds(5),
        // Handler returns { batchItemFailures }; only those go back to the queue.
        reportBatchItemFailures: true,
        // Event-source-mapping level concurrency (2..1000); independent of reserved concurrency.
        maxConcurrency: props.tier.highlyAvailable ? 20 : 2,
      }),
    );
    // (SqsEventSource grants sqs:ReceiveMessage/DeleteMessage/GetQueueAttributes/ChangeMessageVisibility.)

    // --- Alarms you actually need ---------------------------------------------------------
    this.dlqAlarm = new cloudwatch.Alarm(this, 'DlqNotEmpty', {
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1), statistic: 'max' }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Messages in the order-events DLQ: a handler is failing or a poison message arrived',
    });
    new cloudwatch.Alarm(this, 'OldestMessageAge', {
      metric: this.queue.metricApproximateAgeOfOldestMessage({ period: cdk.Duration.minutes(5), statistic: 'max' }),
      threshold: cdk.Duration.minutes(10).toSeconds(),
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Consumer is falling behind (or stopped)',
    });

    // --- EventBridge Scheduler: the modern cron -------------------------------------------
    // Scheduler (aws-scheduler) vs a scheduled events.Rule: time zones, one-off `at()`
    // schedules, flexible time windows, start/end dates, schedule groups, and a built-in
    // retry/DLQ policy per target. Rules are for reacting to events; Scheduler is for time.
    this.reporter = new NodejsFunction(this, 'Reporter', {
      entry: path.join(__dirname, 'handlers', 'scheduled.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(1),
      logGroup: new logs.LogGroup(this, 'ReporterLogs', { retention: logRetentionFor(props.tier), removalPolicy: cdk.RemovalPolicy.DESTROY }),
      loggingFormat: lambda.LoggingFormat.JSON,
      bundling: bundlingFor(props.tier),
    });

    this.schedule = new scheduler.Schedule(this, 'NightlyReport', {
      description: 'Daily orders report at 02:00 London time',
      schedule: scheduler.ScheduleExpression.cron({ minute: '0', hour: '2', timeZone: cdk.TimeZone.EUROPE_LONDON }),
      target: new schedulerTargets.LambdaInvoke(this.reporter, {
        input: scheduler.ScheduleTargetInput.fromObject({ report: 'daily-orders', tier: props.tier.name }),
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
        deadLetterQueue: this.deadLetterQueue,
      }),
      // Spread the invocation over 15 minutes so every account's "02:00 job" does not land at once.
      timeWindow: scheduler.TimeWindow.flexible(cdk.Duration.minutes(15)),
      enabled: true,
    });
  }
}
