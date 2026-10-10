import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { EnvironmentTier, resourceName } from '@cdk-mastery/shared';
import { Construct } from 'constructs';
import { applyGovernance } from './governance';
import { DeveloperBoundary } from './permissions-boundary';

export interface GovernedStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
  /**
   * Add deliberately non-compliant constructs so you can watch the validators
   * fire (`cdk synth -c cdk-mastery:m06-violations=true`). Off by default so the
   * curriculum app synthesizes clean.
   */
  readonly includeViolations?: boolean;
}

/**
 * A stack that is *unremarkable on purpose*: a bucket, a queue, a function, a log
 * group, written the way an application team writes them — no encryption flag,
 * no retention, no tags. `applyGovernance` (called in the constructor, but it
 * would work equally from index.ts or a Stage) makes it compliant at synth time,
 * and cdk-nag acknowledgements document the residual, accepted risk.
 */
export class GovernedStack extends cdk.Stack {
  readonly bucket: s3.Bucket;
  readonly queue: sqs.Queue;
  readonly fn: lambda.Function;
  readonly boundary: DeveloperBoundary;

  constructor(scope: Construct, id: string, props: GovernedStackProps) {
    super(scope, id, props);
    const { tier } = props;

    // Compliant on its own — but note we never set `encryption`; the aspect does.
    this.bucket = new s3.Bucket(this, 'Artifacts', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsPrefix: 'access/',
      removalPolicy: tier.retainStatefulResources ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const dlq = new sqs.Queue(this, 'DeadLetter', { enforceSSL: true });
    this.queue = new sqs.Queue(this, 'Work', {
      enforceSSL: true,
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    // No retention on purpose: LogRetentionAspect sets it from the tier.
    const appLogs = new logs.LogGroup(this, 'AppLogs', {
      logGroupName: `/cdk-mastery/${resourceName({ org: 'revan', service: 'governance', env: tier.name, component: 'app' })}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.fn = new lambda.Function(this, 'Worker', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({ ok: true });'),
      logGroup: appLogs,
      environment: { QUEUE_URL: this.queue.queueUrl },
    });
    this.queue.grantConsumeMessages(this.fn);

    // The boundary is both created here and applied to every role in the stack,
    // including the Lambda's auto-generated one.
    this.boundary = new DeveloperBoundary(this, 'Boundary', {
      policyName: resourceName({ org: 'revan', service: 'governance', env: tier.name, component: 'boundary' }),
    });
    this.boundary.applyTo(this);

    if (props.includeViolations) {
      // 1. Public-access block missing → NoPublicBucketsAspect error.
      new s3.Bucket(this, 'Leaky', { blockPublicAccess: undefined, enforceSSL: true });
      // 2. Snake-case id → ConstructPolicyAspect (PascalCaseIds) error.
      new sqs.Queue(this, 'bad_name', { enforceSSL: true });
      // 3. A 400-day log group in a non-prod tier → LogRetentionAspect clamps it (info, not error).
      new logs.LogGroup(this, 'Chatty', { retention: logs.RetentionDays.THIRTEEN_MONTHS, removalPolicy: cdk.RemovalPolicy.DESTROY });
    }

    applyGovernance(this, { tier, service: 'governance' });

    // ---- cdk-nag acknowledgements ------------------------------------------
    // Each one is a *decision*, so each one carries the reason a reviewer needs.
    // Scoped to the narrowest construct that owns the finding.
    cdk.Validations.of(this.fn).acknowledge(
      {
        id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
        reason: 'AWSLambdaBasicExecutionRole grants only CloudWatch Logs write; the permissions boundary caps it further.',
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'Runtime is pinned to nodejs22.x deliberately; upgrades go through the platform release train, not implicit "latest".',
      },
    );
    cdk.Validations.of(dlq).acknowledge({
      id: 'AwsSolutions-SQS3',
      reason: 'This queue *is* the dead-letter queue; a DLQ for the DLQ is not meaningful.',
    });
    cdk.Validations.of(this.boundary).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason: 'A permissions boundary is a ceiling, not a grant; wildcards here bound, they do not authorise.',
    });
    for (const action of ['s3:*', 'dynamodb:*', 'sqs:*', 'sns:*', 'logs:*', 'lambda:*', 'kms:*', 'ssm:GetParameter*', 'xray:*', 'events:*', 'states:*']) {
      cdk.Validations.of(this.boundary).acknowledge({
        id: `AwsSolutions-IAM5[Action::${action}]`,
        reason: 'Boundary ceiling; see DenyBoundaryEscape statement for the escalation guard.',
      });
    }
  }
}
