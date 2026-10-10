import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { EnvironmentTier } from '@cdk-mastery/shared';
import { Construct } from 'constructs';

export interface AppStageProps extends cdk.StageProps {
  readonly tier: EnvironmentTier;
}

/**
 * The deployable unit. A pipeline never deploys a Stack; it deploys a Stage,
 * which is a self-contained cloud assembly (`cdk.out/assembly-<name>/`) with
 * its own stacks, assets and dependency graph. Two small stacks with a
 * cross-stack reference are enough to see the pipeline order them correctly.
 *
 * `env` comes from the caller (the pipeline knows which account each stage
 * targets); the stacks inherit it from the Stage.
 */
export class AppStage extends cdk.Stage {
  readonly queueStack: QueueStack;
  readonly functionStack: FunctionStack;

  constructor(scope: Construct, id: string, props: AppStageProps) {
    super(scope, id, props);
    this.queueStack = new QueueStack(this, 'Queue', { tier: props.tier });
    this.functionStack = new FunctionStack(this, 'Function', { tier: props.tier, queue: this.queueStack.queue });
  }
}

export interface QueueStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
}

export class QueueStack extends cdk.Stack {
  readonly queue: sqs.Queue;

  constructor(scope: Construct, id: string, props: QueueStackProps) {
    super(scope, id, props);
    const dlq = new sqs.Queue(this, 'DeadLetter', { enforceSSL: true, retentionPeriod: cdk.Duration.days(14) });
    this.queue = new sqs.Queue(this, 'Work', {
      enforceSSL: true,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });
  }
}

export interface FunctionStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
  readonly queue: sqs.IQueue;
}

export class FunctionStack extends cdk.Stack {
  readonly fn: lambda.Function;
  /** Consumed by the pipeline's post-deploy smoke test via `envFromCfnOutputs`. */
  readonly functionNameOutput: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: FunctionStackProps) {
    super(scope, id, props);
    this.fn = new lambda.Function(this, 'Consumer', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'handlers')), // a file asset → the pipeline gets an Assets stage
      timeout: cdk.Duration.seconds(10),
      environment: { STAGE_NAME: props.tier.name },
    });
    this.fn.addEventSource(new eventsources.SqsEventSource(props.queue, { batchSize: 10, reportBatchItemFailures: true }));

    this.functionNameOutput = new cdk.CfnOutput(this, 'FunctionName', { value: this.fn.functionName });
  }
}
