import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvironmentTier } from '@cdk-mastery/shared';

/**
 * Nested stacks: one CloudFormation stack that owns child stacks.
 *
 * What CDK does with `NestedStack`:
 *   - the nested template is written to cdk.out as a *file asset* and uploaded to the
 *     bootstrap bucket; the parent gets an `AWS::CloudFormation::Stack` resource whose
 *     `TemplateURL` points at it;
 *   - parent → nested values become nested-template *Parameters*;
 *   - nested → parent values become nested-template *Outputs* read with
 *     `Fn::GetAtt [NestedStackLogicalId, Outputs.<Name>]`;
 *   - the whole thing deploys as ONE change set, atomically, with one rollback.
 *
 * When to use: the parent needs more than 500 resources, or a repeated unit (per-tenant,
 * per-queue) should be one logical deployment. When not to: to split ownership or
 * deployment cadence — nested stacks share a lifecycle with their parent, so use
 * separate stacks (and SSM/weak references) for that. Nested stacks also make `cdk diff`
 * less readable (changes appear as a new TemplateURL hash) and every nested template
 * costs an asset upload.
 */
export interface QueueTierProps {
  readonly tier: EnvironmentTier;
  readonly visibilityTimeout: cdk.Duration;
}

export class QueueTier extends cdk.NestedStack {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: QueueTierProps) {
    super(scope, id, { description: `Queue tier for ${props.tier.name}` });

    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetter', {
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    this.queue = new sqs.Queue(this, 'Work', {
      enforceSSL: true,
      visibilityTimeout: props.visibilityTimeout,
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 5 },
    });
  }
}

export interface NestedDemoStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
}

export class NestedDemoStack extends cdk.Stack {
  readonly queues: QueueTier;
  readonly consumerRole: iam.Role;

  constructor(scope: Construct, id: string, props: NestedDemoStackProps) {
    super(scope, id, props);

    this.queues = new QueueTier(this, 'Queues', { tier: props.tier, visibilityTimeout: cdk.Duration.seconds(90) });

    // A parent resource referencing a nested resource: CDK adds an Output to the nested
    // template and a Fn::GetAtt on the parent's AWS::CloudFormation::Stack resource.
    this.consumerRole = new iam.Role(this, 'Consumer', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    this.queues.queue.grantConsumeMessages(this.consumerRole);
  }
}
