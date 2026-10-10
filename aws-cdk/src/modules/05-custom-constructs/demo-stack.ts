import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { EnvironmentTier, resourceName } from '@cdk-mastery/shared';
import { QueueWorker } from './queue-worker';
import { SecureBucket, SecureBucketEncryption } from './secure-bucket';
import { ServiceDashboard } from './service-dashboard';

/** The three constructs composed the way a service team would use them. */
export interface ConstructsDemoStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
}

export class ConstructsDemoStack extends cdk.Stack {
  readonly documents: SecureBucket;
  readonly worker: QueueWorker;
  readonly dashboard: ServiceDashboard;

  constructor(scope: Construct, id: string, props: ConstructsDemoStackProps) {
    super(scope, id, props);
    const retain = props.tier.retainStatefulResources;

    this.documents = new SecureBucket(this, 'Documents', {
      bucketName: resourceName({ org: 'cdkm', service: 'm05', env: props.tier.name, component: 'documents' }),
      encryption: SecureBucketEncryption.KMS,
      lifecycle: { transitionAfter: cdk.Duration.days(30), expireNoncurrentAfter: cdk.Duration.days(120) },
      removalPolicy: retain ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.worker = new QueueWorker(this, 'Ingest', {
      code: lambda.Code.fromAsset(path.join(__dirname, 'handlers')),
      handler: 'worker.handler',
      timeout: cdk.Duration.seconds(20),
      batchSize: 5,
      maxReceiveCount: 3,
      environment: { BUCKET_NAME: this.documents.bucket.bucketName },
      alarmThresholds: { oldestMessageAge: cdk.Duration.minutes(5) },
    });
    // grant* on the L3 delegates to the L2: the worker gets s3:GetObject* + kms:Decrypt on the key.
    this.documents.grantRead(this.worker.handler);

    this.dashboard = new ServiceDashboard(this, 'Dashboard', {
      serviceName: `cdkm-m05-${props.tier.name}`,
      metrics: [
        this.worker.metricOldestMessageAge(),
        this.worker.metricDeadLetterDepth(),
        this.worker.handler.metricErrors({ statistic: cloudwatch.Stats.SUM }),
        this.worker.handler.metricDuration({ statistic: 'p99' }),
        this.documents.metricNumberOfObjects(),
        this.documents.metricBucketSizeBytes(),
      ],
      alarms: this.worker.alarms,
      columns: 3,
    });
  }
}
