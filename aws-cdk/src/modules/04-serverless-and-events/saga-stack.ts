import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { EnvironmentTier } from '@cdk-mastery/shared';
import { bundlingFor, logRetentionFor } from './api-stack';

/**
 * A Step Functions saga: reserve inventory → charge payment → record order, with
 * compensation (release inventory) when payment is declined.
 *
 *   Reserve ──(ok)──> Charge ──> Charged? ──yes──> RecordOrder (DynamoDB PutItem) ──> Succeed
 *     │                 │            └────no────> Release ──> Fail(PaymentDeclined)
 *     │                 └──catch PaymentDeclined──^
 *     └──retry ServiceUnavailable (x3, backoff)
 *
 * Why a state machine and not a Lambda calling three services: each step is durable and
 * individually retried, the compensation path is explicit and visible in the console,
 * execution history is the audit log, and the DynamoDB write needs no code at all —
 * `DynamoPutItem` is an optimised integration (no Lambda in the loop).
 *
 * JSONPath is used throughout (`$.orderId`, `resultPath`). Step Functions also supports
 * JSONata (`queryLanguage: QueryLanguage.JSONATA`) since late 2024; the JSONPath form is
 * still the more widely documented one and is what `DefinitionBody.fromChainable` renders
 * by default here.
 */
export interface SagaStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
  readonly table: dynamodb.ITableV2;
}

export class SagaStack extends cdk.Stack {
  readonly stateMachine: sfn.StateMachine;
  readonly steps: NodejsFunction;

  constructor(scope: Construct, id: string, props: SagaStackProps) {
    super(scope, id, props);

    this.steps = new NodejsFunction(this, 'Steps', {
      entry: path.join(__dirname, 'handlers', 'saga.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(15),
      logGroup: new logs.LogGroup(this, 'StepsLogs', { retention: logRetentionFor(props.tier), removalPolicy: cdk.RemovalPolicy.DESTROY }),
      loggingFormat: lambda.LoggingFormat.JSON,
      bundling: bundlingFor(props.tier),
    });

    // Each LambdaInvoke passes an explicit payload (never the whole state) and stores its
    // result under its own key with `resultPath`, so later states can still see the input.
    const invoke = (name: string, action: 'reserve' | 'charge' | 'release') =>
      new tasks.LambdaInvoke(this, name, {
        lambdaFunction: this.steps,
        payload: sfn.TaskInput.fromObject({
          action,
          orderId: sfn.JsonPath.stringAt('$.orderId'),
          total: sfn.JsonPath.numberAt('$.total'),
          simulate: sfn.JsonPath.stringAt('$.simulate'),
        }),
        payloadResponseOnly: true, // unwrap the Lambda envelope; result is the handler's return value
        resultPath: `$.${action}`,
        retryOnServiceExceptions: true, // Lambda.ServiceException, Lambda.TooManyRequestsException, ...
      });

    const reserve = invoke('ReserveInventory', 'reserve');
    const charge = invoke('ChargePayment', 'charge');
    const release = invoke('ReleaseInventory', 'release');

    // Retry is for transient failures the step itself signals; it happens before Catch.
    for (const step of [reserve, charge, release]) {
      step.addRetry({ errors: ['ServiceUnavailable'], interval: cdk.Duration.seconds(2), maxAttempts: 3, backoffRate: 2 });
    }

    const record = new tasks.DynamoPutItem(this, 'RecordOrder', {
      table: props.table,
      item: {
        pk: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.format('ORDER#{}', sfn.JsonPath.stringAt('$.orderId'))),
        sk: tasks.DynamoAttributeValue.fromString('SAGA'),
        paymentReference: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.charge.reference')),
        reservationReference: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.reserve.reference')),
        status: tasks.DynamoAttributeValue.fromString('confirmed'),
      },
      resultPath: sfn.JsonPath.DISCARD, // keep the state as-is; PutItem's response is noise
    });

    const declined = new sfn.Fail(this, 'PaymentDeclined', { error: 'PaymentDeclined', cause: 'Payment was declined; inventory released' });
    const done = new sfn.Succeed(this, 'OrderConfirmed');

    // Compensation: Catch on the charge step routes to Release, keeping the error under $.error.
    charge.addCatch(release, { errors: ['PaymentDeclined'], resultPath: '$.error' });
    release.next(declined);

    // A Choice after the charge in case the handler returns ok=false instead of throwing.
    const charged = new sfn.Choice(this, 'Charged?')
      .when(sfn.Condition.booleanEquals('$.charge.ok', true), record.next(done))
      .otherwise(release);

    const definition = reserve.next(charge).next(charged);

    this.stateMachine = new sfn.StateMachine(this, 'OrderSaga', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD, // durable, up to 1 year, exactly-once state transitions
      timeout: cdk.Duration.minutes(5),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'SagaLogs', { retention: logRetentionFor(props.tier), removalPolicy: cdk.RemovalPolicy.DESTROY }),
        level: sfn.LogLevel.ERROR,
        includeExecutionData: false, // payloads may contain PII; error-level metadata is enough
      },
    });
    // The L2 grants lambda:InvokeFunction on `steps` and dynamodb:PutItem on the table to the
    // state machine role — and nothing else — from the tasks above.
  }
}
