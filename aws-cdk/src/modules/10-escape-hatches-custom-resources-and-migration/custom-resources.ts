import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface SlowResourceProps {
  readonly name: string;
  /** Seconds the simulated job takes; drives the isComplete polling. */
  readonly waitSeconds: number;
}

/**
 * A Provider-framework custom resource (rung 8 of the ladder).
 *
 * `cr.Provider` is a mini-framework: it deploys a *framework* Lambda that speaks
 * the raw CloudFormation custom-resource protocol (the signed S3 response URL,
 * the 1-hour deadline, the retry semantics) and calls *your* handlers with a
 * clean event. With an `isCompleteHandler` it also deploys a Step Functions
 * waiter state machine that polls `isComplete` every `queryInterval` until
 * `totalTimeout`. You write two small functions; the framework owns the protocol.
 *
 * Use it when the operation is long-running or must be polled (certificate
 * issuance, index builds, cross-account setup). For a single SDK call use
 * `AwsCustomResource` instead (below) — no code to own.
 */
export class SlowResource extends Construct {
  readonly resource: cdk.CustomResource;
  /** Attribute returned by isComplete's `Data.Result`. */
  readonly result: string;

  constructor(scope: Construct, id: string, props: SlowResourceProps) {
    super(scope, id);

    const onEvent = new lambda.Function(this, 'OnEvent', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'on-event.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'handlers')),
      timeout: cdk.Duration.minutes(1),
      logGroup: new logs.LogGroup(this, 'OnEventLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
    const isComplete = new lambda.Function(this, 'IsComplete', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'is-complete.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'handlers')),
      timeout: cdk.Duration.minutes(1),
      logGroup: new logs.LogGroup(this, 'IsCompleteLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });

    // One Provider per resource *type*, shared by all instances of that type in
    // the stack — it is a Lambda + state machine, not something to create per resource.
    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: onEvent,
      isCompleteHandler: isComplete,
      queryInterval: cdk.Duration.seconds(10),
      totalTimeout: cdk.Duration.minutes(10), // CloudFormation's own limit is 1 hour per resource
      logGroup: new logs.LogGroup(this, 'ProviderLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });

    this.resource = new cdk.CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::SlowResource', // shows up in the template and in CloudTrail; keep it stable
      properties: { Name: props.name, WaitSeconds: props.waitSeconds },
      // Properties are the *only* thing CloudFormation diffs: change one and
      // Update is sent; change none and the resource is untouched on deploy.
    });
    this.result = this.resource.getAttString('Result');
  }
}

export interface ParameterWriterProps {
  readonly parameterName: string;
  readonly value: string;
}

/**
 * `AwsCustomResource`: one SDK call per lifecycle event, no handler code.
 *
 * The singleton Lambda behind it takes `{ service, action, parameters }` and
 * calls the AWS SDK v3 at deploy time. Three things people get wrong:
 *
 *  - `physicalResourceId`: CloudFormation needs a stable id. `PhysicalResourceId.of(name)`
 *    (a constant) means updates are in-place; `PhysicalResourceId.fromResponse(path)`
 *    ties it to the API response — a *new* id on Update triggers a Delete of the old one.
 *  - `installLatestAwsSdk`: `true` runs `npm install aws-sdk` *inside the Lambda at
 *    runtime* — a network call to npm during every deployment, slow and a supply-chain
 *    risk. The runtime's bundled SDK v3 is what you want; the feature flag
 *    `@aws-cdk/customresources:installLatestAwsSdkDefault` is false in this repo's
 *    cdk.json, and we set it explicitly so tests (no cdk.json) match.
 *  - `policy`: `fromSdkCalls({ resources })` derives IAM actions from the calls.
 *    `resources: ANY_RESOURCE` is `*`; scope it to the ARNs you touch.
 */
export class ParameterWriter extends Construct {
  readonly resource: cr.AwsCustomResource;

  constructor(scope: Construct, id: string, props: ParameterWriterProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const parameterArn = stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: props.parameterName.replace(/^\//, '') });

    const put: cr.AwsSdkCall = {
      service: 'SSM',
      action: 'PutParameter', // v3 action names without the "Command" suffix also work; keep the SDK v2-style name for readability
      parameters: { Name: props.parameterName, Value: props.value, Type: 'String', Overwrite: true },
      physicalResourceId: cr.PhysicalResourceId.of(props.parameterName),
    };

    this.resource = new cr.AwsCustomResource(this, 'Resource', {
      resourceType: 'Custom::SsmParameterWriter',
      onCreate: put,
      onUpdate: put, // Value in `parameters` changed → CloudFormation sends Update → PutParameter again
      onDelete: {
        service: 'SSM',
        action: 'DeleteParameter',
        parameters: { Name: props.parameterName },
        // Rollbacks may delete a parameter that never got written.
        ignoreErrorCodesMatching: 'ParameterNotFound',
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [parameterArn] }),
      installLatestAwsSdk: false,
      timeout: cdk.Duration.minutes(2),
      logGroup: new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
  }
}
