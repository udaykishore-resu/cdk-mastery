import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { EnvironmentTier, resourceName } from '@cdk-mastery/shared';
import { Construct } from 'constructs';
import { ORG, SERVICE, sizingFor } from '../config';
import { retentionDays } from './network-stack';

export interface WorkerStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
  /** By name, for the same reason as ApiStack: no export coupling in IAM statements. */
  readonly tableName: string;
  readonly bus: events.IEventBus;
  readonly key: kms.IKey;
  readonly vpc: ec2.IVpc;
  readonly securityGroup: ec2.ISecurityGroup;
}

/**
 * EventBridge rule → SQS (+ DLQ) → Lambda in the VPC → DynamoDB.
 *
 * Why the queue in the middle? EventBridge → Lambda directly retries for 24 h
 * with its own backoff and then drops the event. A queue gives you a buffer
 * you can see (ApproximateNumberOfMessagesVisible), a DLQ you can replay from,
 * batch processing with partial failures, and a knob (reserved concurrency)
 * to protect the table. The cost is one more hop and ~100 ms latency.
 *
 * `visibilityTimeout` ≥ 6 × function timeout is the documented rule so a slow
 * batch is never redelivered while still in flight.
 */
export class WorkerStack extends cdk.Stack {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly worker: lambda.Function;
  readonly table: dynamodb.ITableV2;

  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);
    const { tier } = props;
    const sizing = sizingFor(tier);
    const retention = retentionDays(tier.logRetentionDays);
    const timeout = cdk.Duration.seconds(30);

    this.table = dynamodb.TableV2.fromTableAttributes(this, 'OrdersTable', { tableName: props.tableName, encryptionKey: props.key });

    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetter', {
      queueName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'orders-dlq' }),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.key,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14), // the maximum: replay windows are measured in days during incidents
    });
    this.queue = new sqs.Queue(this, 'Queue', {
      queueName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'orders-work' }),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.key,
      enforceSSL: true,
      visibilityTimeout: cdk.Duration.seconds(timeout.toSeconds() * 6),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 5 },
    });

    new events.Rule(this, 'OrderCreated', {
      ruleName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'order-created' }),
      eventBus: props.bus,
      eventPattern: { source: ['orders.api'], detailType: ['OrderCreated'] },
      targets: [new targets.SqsQueue(this.queue, { deadLetterQueue: this.deadLetterQueue, retryAttempts: 3 })],
    });

    this.worker = new lambda.Function(this, 'Worker', {
      functionName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'worker' }),
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'worker.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'handlers')),
      memorySize: sizing.workerMemoryMb,
      timeout,
      architecture: lambda.Architecture.ARM_64,
      reservedConcurrentExecutions: sizing.workerReservedConcurrency,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.securityGroup],
      environment: { TABLE_NAME: this.table.tableName },
      logGroup: new logs.LogGroup(this, 'WorkerLogs', { retention, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      tracing: lambda.Tracing.ACTIVE,
    });
    this.worker.addEventSource(
      new eventsources.SqsEventSource(this.queue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        reportBatchItemFailures: true, // handler returns batchItemFailures; only failed messages are retried
      }),
    );
    this.table.grantReadWriteData(this.worker);
  }
}
