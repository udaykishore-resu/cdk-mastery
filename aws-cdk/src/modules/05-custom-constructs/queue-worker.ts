import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/**
 * QueueWorker — SQS + DLQ + Lambda + the two alarms every queue consumer needs.
 *
 * The `IQueueWorker` / `fromQueueWorkerAttributes` pair is the pattern every AWS L2 uses
 * (`IBucket` / `Bucket.fromBucketAttributes`): consumers code against the interface, and
 * a worker that lives in another stack, account or app can be *imported* by its
 * attributes and still offer `grantSend` and `metric*`. Only the things that work on an
 * imported resource belong on the interface — you cannot add an event source to a
 * function you do not own, so that is not on `IQueueWorker`.
 */
export interface IQueueWorker {
  readonly queue: sqs.IQueue;
  readonly deadLetterQueue: sqs.IQueue;
  readonly handler: lambda.IFunction;
  /** Allow a producer to enqueue work. */
  grantSend(grantee: iam.IGrantable): iam.Grant;
  /** Visible messages in the DLQ — anything > 0 is a page. */
  metricDeadLetterDepth(props?: cloudwatch.MetricOptions): cloudwatch.Metric;
  /** Age of the oldest message in the work queue — rising means the consumer is behind. */
  metricOldestMessageAge(props?: cloudwatch.MetricOptions): cloudwatch.Metric;
}

export interface QueueWorkerAttributes {
  readonly queueArn: string;
  readonly deadLetterQueueArn: string;
  readonly functionArn: string;
}

export interface QueueWorkerAlarmThresholds {
  /** DLQ depth that triggers the alarm. @default 1 (i.e. any message) */
  readonly deadLetterDepth?: number;
  /** Oldest-message age that triggers the alarm. @default 10 minutes */
  readonly oldestMessageAge?: cdk.Duration;
}

export interface QueueWorkerProps {
  /** Handler code (plain JS asset or inline; bundle outside if TypeScript). */
  readonly code: lambda.Code;
  /** @default 'index.handler' */
  readonly handler?: string;
  /** @default Runtime.NODEJS_22_X */
  readonly runtime?: lambda.Runtime;
  /** @default 30 seconds. The queue's visibility timeout is derived as 6x this. */
  readonly timeout?: cdk.Duration;
  /** @default 10 */
  readonly batchSize?: number;
  /** Receives before a message is dead-lettered. @default 3 */
  readonly maxReceiveCount?: number;
  /** @default 2 (SQS minimum) */
  readonly maxConcurrency?: number;
  /** @default RetentionDays.ONE_MONTH */
  readonly logRetention?: logs.RetentionDays;
  /** @default - see QueueWorkerAlarmThresholds */
  readonly alarmThresholds?: QueueWorkerAlarmThresholds;
  readonly environment?: Record<string, string>;
}

/** Shared implementation of the interface's derived members, for both real and imported workers. */
abstract class QueueWorkerBase extends Construct implements IQueueWorker {
  abstract readonly queue: sqs.IQueue;
  abstract readonly deadLetterQueue: sqs.IQueue;
  abstract readonly handler: lambda.IFunction;

  grantSend(grantee: iam.IGrantable): iam.Grant {
    return this.queue.grantSendMessages(grantee);
  }

  metricDeadLetterDepth(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1), statistic: cloudwatch.Stats.MAXIMUM, ...props });
  }

  metricOldestMessageAge(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.queue.metricApproximateAgeOfOldestMessage({ period: cdk.Duration.minutes(5), statistic: cloudwatch.Stats.MAXIMUM, ...props });
  }
}

export class QueueWorker extends QueueWorkerBase {
  /**
   * Import a worker deployed elsewhere. Everything on `IQueueWorker` works; nothing that
   * needs ownership (event sources, alarms, environment) is available.
   */
  static fromQueueWorkerAttributes(scope: Construct, id: string, attrs: QueueWorkerAttributes): IQueueWorker {
    class Imported extends QueueWorkerBase {
      readonly queue = sqs.Queue.fromQueueArn(this, 'Queue', attrs.queueArn);
      readonly deadLetterQueue = sqs.Queue.fromQueueArn(this, 'DeadLetterQueue', attrs.deadLetterQueueArn);
      readonly handler = lambda.Function.fromFunctionArn(this, 'Handler', attrs.functionArn);
    }
    return new Imported(scope, id);
  }

  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly handler: lambda.Function;
  readonly logGroup: logs.LogGroup;
  readonly deadLetterAlarm: cloudwatch.Alarm;
  readonly oldestMessageAlarm: cloudwatch.Alarm;
  /** Every alarm this construct owns, so callers can wire actions without knowing the names. */
  readonly alarms: cloudwatch.Alarm[];

  constructor(scope: Construct, id: string, props: QueueWorkerProps) {
    super(scope, id);

    const timeout = props.timeout ?? cdk.Duration.seconds(30);
    const batchSize = props.batchSize ?? 10;
    const maxReceiveCount = props.maxReceiveCount ?? 3;
    if (batchSize < 1 || batchSize > 10_000) throw new Error(`QueueWorker "${this.node.path}": batchSize must be 1..10000 (got ${batchSize})`);
    if (maxReceiveCount < 1) throw new Error(`QueueWorker "${this.node.path}": maxReceiveCount must be >= 1`);
    if (batchSize > 10) {
      cdk.Annotations.of(this).addWarningV2('cdk-mastery:QueueWorker.largeBatch', `batchSize ${batchSize} > 10 requires maxBatchingWindow; the event source sets 5 seconds.`);
    }

    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.queue = new sqs.Queue(this, 'Queue', {
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(timeout.toSeconds() * 6),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount },
    });

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.handler = new lambda.Function(this, 'Handler', {
      code: props.code,
      handler: props.handler ?? 'index.handler',
      runtime: props.runtime ?? lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout,
      logGroup: this.logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      environment: props.environment,
    });
    this.handler.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize,
        maxBatchingWindow: batchSize > 10 ? cdk.Duration.seconds(5) : undefined,
        reportBatchItemFailures: true,
        maxConcurrency: props.maxConcurrency ?? 2,
      }),
    );

    const thresholds = props.alarmThresholds ?? {};
    this.deadLetterAlarm = new cloudwatch.Alarm(this, 'DeadLetterAlarm', {
      metric: this.metricDeadLetterDepth(),
      threshold: thresholds.deadLetterDepth ?? 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: `${this.node.path}: messages in the dead-letter queue`,
    });
    this.oldestMessageAlarm = new cloudwatch.Alarm(this, 'OldestMessageAlarm', {
      metric: this.metricOldestMessageAge(),
      threshold: (thresholds.oldestMessageAge ?? cdk.Duration.minutes(10)).toSeconds(),
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: `${this.node.path}: consumer is falling behind`,
    });
    this.alarms = [this.deadLetterAlarm, this.oldestMessageAlarm];

    // Synth-time validation reads the L1 properties as they stand after every constructor
    // ran, so it still holds if a caller reaches in and sets `cfnQueue.messageRetentionPeriod`
    // after construction. (Raw `addPropertyOverride` values are applied at render time and
    // are invisible to L1 property getters — one more reason to prefer typed L1 setters.)
    this.node.addValidation({
      validate: () => {
        const queueL1 = this.queue.node.defaultChild as sqs.CfnQueue;
        const dlqL1 = this.deadLetterQueue.node.defaultChild as sqs.CfnQueue;
        const queueRetention = cdk.Stack.of(this).resolve(queueL1.messageRetentionPeriod) ?? cdk.Duration.days(4).toSeconds();
        const dlqRetention = cdk.Stack.of(this).resolve(dlqL1.messageRetentionPeriod) ?? cdk.Duration.days(4).toSeconds();
        return dlqRetention > queueRetention
          ? []
          : [`dead-letter queue retention (${dlqRetention}s) must exceed the work queue retention (${queueRetention}s) or dead-lettered messages expire before anyone looks`];
      },
    });
  }
}
