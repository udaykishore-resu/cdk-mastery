import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * The same resource — an S3 bucket — at all three construct levels.
 *
 * L1 (`CfnBucket`):  exactly the CloudFormation resource. Property names are the CFN
 *                    names (PascalCase in the template, camelCase in TS). No defaults, no
 *                    helpers, no policy: what you write is what you get.
 * L2 (`Bucket`):     an opinionated wrapper. `enforceSSL` alone adds a BucketPolicy child;
 *                    `grantRead()` writes IAM statements for you; `bucketArn` is a token
 *                    you can pass around. Its L1 is `bucket.node.defaultChild`.
 * L3 (`ArchiveBucket`, below): a *pattern* — several L2s wired for one use case
 *                    ("a bucket for compliance archives with access logging and Glacier
 *                    tiering"). It is just a Construct with L2 children; the framework has
 *                    no notion of "L3", it is a naming convention.
 */

export interface LevelsStackProps extends cdk.StackProps {
  readonly tier: string;
}

export class LevelsStack extends cdk.Stack {
  readonly l1: s3.CfnBucket;
  readonly l2: s3.Bucket;
  readonly l3: ArchiveBucket;

  constructor(scope: Construct, id: string, props: LevelsStackProps) {
    super(scope, id, props);

    // L1: note `versioningConfiguration: { status: 'Enabled' }` — the CFN shape, verbatim.
    this.l1 = new s3.CfnBucket(this, 'RawBucket', {
      versioningConfiguration: { status: 'Enabled' },
      publicAccessBlockConfiguration: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
    });

    // L2: `versioned: true` is the same thing, and public access is blocked by default
    // (feature flag `@aws-cdk/aws-s3:publicAccessBlockedByDefault` is on in cdk.json; in a
    // bare `new cdk.App()` the L2 still sets BlockPublicAccess.BLOCK_ALL unless told otherwise).
    this.l2 = new s3.Bucket(this, 'NiceBucket', {
      versioned: true,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.l3 = new ArchiveBucket(this, 'Archive', {
      tier: props.tier,
      transitionAfter: cdk.Duration.days(30),
    });
  }
}

export interface ArchiveBucketProps {
  readonly tier: string;
  /** How long objects stay in Standard before moving to Glacier Instant Retrieval. */
  readonly transitionAfter?: cdk.Duration;
}

/** A minimal L3: two L2 buckets and a lifecycle rule, exposed through a small typed surface. */
export class ArchiveBucket extends Construct {
  readonly bucket: s3.Bucket;
  readonly accessLogs: s3.Bucket;

  constructor(scope: Construct, id: string, props: ArchiveBucketProps) {
    super(scope, id);

    this.accessLogs = new s3.Bucket(this, 'AccessLogs', {
      enforceSSL: true,
      // The log bucket must let `logging.s3.amazonaws.com` write. HOW the L2 grants that
      // depends on the feature flag `@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy`:
      //   on  (cdk.json, recommended): a bucket-policy statement scoped by aws:SourceArn,
      //       compatible with ObjectOwnership=BucketOwnerEnforced (ACLs disabled).
      //   off (a bare `new cdk.App()` in tests): the legacy LogDeliveryWrite ACL, which
      //       forces ObjectOwnership=ObjectWriter and rejects BucketOwnerEnforced.
      // Do not pin objectOwnership here; let the flag decide, and assert on it in tests.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.bucket = new s3.Bucket(this, 'Bucket', {
      versioned: true,
      enforceSSL: true,
      serverAccessLogsBucket: this.accessLogs,
      serverAccessLogsPrefix: 'archive/',
      lifecycleRules: [
        {
          id: 'tier-to-glacier-ir',
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: props.transitionAfter ?? cdk.Duration.days(90),
            },
          ],
          noncurrentVersionExpiration: cdk.Duration.days(365),
        },
      ],
      // A compliance archive keeps its data even if the stack is deleted, unless dev.
      removalPolicy: props.tier === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
  }
}
