import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface S3ObjectWriterProps {
  readonly bucket: s3.IBucket;
  readonly key: string;
  readonly body: string;
  readonly contentType?: string;
}

/**
 * Exercise 3 — a Provider-framework custom resource with `onEvent` only.
 *
 * Writes one object at deploy time (a generated config file, a "deployed at"
 * marker, a robots.txt). `aws-s3-deployment` does this for whole directories
 * with a bigger footprint; for one small object a 30-line handler is simpler.
 *
 * Least privilege is the point of the exercise: the handler role gets
 * `s3:PutObject`/`s3:DeleteObject` on **this key only** (`bucket.arnForObjects(key)`),
 * not on the bucket. The framework Lambda that `cr.Provider` creates has no S3
 * permissions at all — it only invokes the handler.
 *
 * `serviceTimeout` on the CustomResource caps how long CloudFormation waits for
 * a response (default 1 hour); a synchronous PutObject needs seconds.
 */
export class S3ObjectWriter extends Construct {
  readonly resource: cdk.CustomResource;
  readonly url: string;

  constructor(scope: Construct, id: string, props: S3ObjectWriterProps) {
    super(scope, id);

    const handler = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 's3-object-writer.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'handlers')),
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'HandlerLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'WriteExactlyThisObject',
        actions: ['s3:PutObject', 's3:DeleteObject'],
        resources: [props.bucket.arnForObjects(props.key)],
      }),
    );

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: handler,
      logGroup: new logs.LogGroup(this, 'ProviderLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });

    this.resource = new cdk.CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::S3ObjectWriter',
      properties: { Bucket: props.bucket.bucketName, Key: props.key, Body: props.body, ContentType: props.contentType ?? 'text/plain' },
      serviceTimeout: cdk.Duration.minutes(2),
    });
    this.url = this.resource.getAttString('Url');
  }
}
