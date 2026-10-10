import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/**
 * Exercise 3 — a private worker service (no load balancer) on Fargate Spot with a secret.
 *
 * Three things the ALB examples did not show:
 *   1. Capacity provider strategy: `base: 1` on FARGATE guarantees one on-demand task;
 *      the rest lean 3:1 towards FARGATE_SPOT. Spot tasks get SIGTERM + 2 minutes; the
 *      worker must stop polling and finish in-flight messages on SIGTERM.
 *   2. Secrets: `ecs.Secret.fromSecretsManager(secret, 'field')` injects the value at task
 *      start via the *execution* role (ECS reads the secret, not your code) — it never
 *      appears in the task definition or the console. `grant*` is done for you.
 *   3. Least privilege on the *task* role: `queue.grantConsumeMessages(taskDefinition.taskRole)`
 *      — nothing else. The execution role only gets ECR pull, logs and the secret.
 */
export interface SpotWorkerProps {
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
  readonly queue: sqs.IQueue;
  readonly databaseSecret: secretsmanager.ISecret;
  readonly logGroup: logs.ILogGroup;
}

export class SpotWorker extends Construct {
  readonly service: ecs.FargateService;
  readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: SpotWorkerProps) {
    super(scope, id);

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', { cpu: 256, memoryLimitMiB: 512 });
    this.taskDefinition.addContainer('Worker', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:stable'), // stand-in image
      logging: ecs.LogDrivers.awsLogs({ logGroup: props.logGroup, streamPrefix: 'worker' }),
      environment: { QUEUE_URL: props.queue.queueUrl },
      secrets: { DB_PASSWORD: ecs.Secret.fromSecretsManager(props.databaseSecret, 'password') },
      stopTimeout: cdk.Duration.seconds(120), // Fargate max; matches the Spot interruption notice
    });
    props.queue.grantConsumeMessages(this.taskDefinition.taskRole);

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: 2,
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { enable: true, rollback: true },
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE', base: 1, weight: 1 },
        { capacityProvider: 'FARGATE_SPOT', weight: 3 },
      ],
    });

    // Scale on queue depth per task rather than CPU: workers are I/O bound.
    const scaling = this.service.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 10 });
    scaling.scaleOnMetric('QueueDepth', {
      metric: props.queue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
      scalingSteps: [
        { upper: 0, change: -1 },
        { lower: 100, change: +1 },
        { lower: 500, change: +3 },
      ],
      adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.minutes(2),
    });
  }
}
