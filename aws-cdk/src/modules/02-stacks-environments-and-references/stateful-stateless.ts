import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvironmentTier } from '@cdk-mastery/shared';

/**
 * Stateful / stateless separation and cross-stack references.
 *
 * The one stack-boundary rule that survives contact with production: **resources that
 * hold data go in a stack that changes rarely and is protected; everything that can be
 * recreated from source goes in a stack that changes often and can be torn down.**
 * Deployment blast radius, termination protection, removal policies and IAM for the
 * deploy role all follow from that split.
 *
 * Passing `stateful.table` into `StatelessStack` creates a *cross-stack reference*. CDK
 * detects that a token from stack A is rendered inside stack B during the prepare phase
 * (module 00) and wires it up. HOW it wires it depends on the reference *strength*
 * (aws-cdk-lib ≥ 2.254):
 *
 *   strong (default when the flag is unset — e.g. in a bare test App):
 *     producer gets `Outputs.ExportsOutput…` with an `Export.Name`, consumer gets
 *     `Fn::ImportValue`. CloudFormation refuses to delete an Export in use, which
 *     protects the producer — and causes the "deadly embrace" below.
 *   weak (what aws-cdk/cdk.json sets via `@aws-cdk/core:defaultCrossStackReferences`):
 *     producer gets a plain `Output`, consumer reads it with `Fn::GetStackOutput`. No
 *     Export, no embrace; the producer can be updated or deleted independently — and
 *     the consumer will fail at deploy time if the output disappeared.
 *   both: transitional — producer emits the Export AND the Output; consumer uses
 *     `Fn::GetStackOutput`. Deploy with "both", then switch to "weak".
 *
 * The deadly embrace (strong only): remove the consumer's use of `table` and deploy.
 * The producer's template no longer contains the Export (CDK only emits exports that
 * are referenced) → CloudFormation: "Export M02-Stateful:ExportsOutputRef… cannot be
 * deleted as it is in use by M02-Stateless". Neither stack can proceed. Fix: keep the
 * export alive explicitly with `this.exportValue(this.table.tableName)` in the producer
 * (`retainExports` below), deploy both, then remove `exportValue` and deploy again.
 */
export interface StatefulStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
  /**
   * Phase-2 flag for the deadly-embrace fix: keep the exports alive after the consumer
   * stopped referencing them. Remove once both stacks are deployed.
   */
  readonly retainExports?: boolean;
  /**
   * Make every reference to the bucket weak regardless of the app-wide flag.
   * (`CrossStackReferences.of(resource).produce(...)` — per-resource control.)
   */
  readonly weakBucketReferences?: boolean;
}

export class StatefulStack extends cdk.Stack {
  readonly table: dynamodb.TableV2;
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StatefulStackProps) {
    super(scope, id, {
      ...props,
      // A stack that holds data must not be deletable by a fat-fingered `cdk destroy --all`.
      terminationProtection: props.terminationProtection ?? props.tier.retainStatefulResources,
    });

    const removalPolicy = props.tier.retainStatefulResources ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    this.table = new dynamodb.TableV2(this, 'Orders', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.tier.retainStatefulResources },
      removalPolicy,
    });

    this.bucket = new s3.Bucket(this, 'Documents', {
      versioned: true,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: removalPolicy === cdk.RemovalPolicy.DESTROY,
    });

    if (props.weakBucketReferences) {
      cdk.CrossStackReferences.of(this.bucket).produce(cdk.ReferenceStrength.WEAK);
    }

    if (props.retainExports) {
      // Emits Outputs.ExportsOutputRefOrders…/ExportsOutputFnGetAttOrders…Arn… with the SAME
      // export names CDK generated automatically, so the deployed consumer keeps resolving.
      this.exportValue(this.table.tableName);
      this.exportValue(this.table.tableArn);
    }
  }
}

export interface StatelessStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
  /** The stateful stack whose resources this stack consumes. */
  readonly stateful: StatefulStack;
  /** Set to false to simulate "the consumer stopped using the table" (embrace step 1). */
  readonly useTable?: boolean;
  /** Set to true to also reference the bucket (a second, independently-weakenable reference). */
  readonly useBucket?: boolean;
}

/** Compute, config and IAM: everything here can be destroyed and redeployed at will. */
export class StatelessStack extends cdk.Stack {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: StatelessStackProps) {
    super(scope, id, props);

    this.role = new iam.Role(this, 'ApiRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });

    if (props.useTable ?? true) {
      // Two references: tableName (Ref) and tableArn (GetAtt) — each becomes its own export/output.
      new ssm.StringParameter(this, 'TableName', {
        parameterName: `/cdk-mastery/${props.tier.name}/api/table-name`,
        stringValue: props.stateful.table.tableName,
      });
      props.stateful.table.grantReadWriteData(this.role);
    }

    if (props.useBucket) {
      props.stateful.bucket.grantRead(this.role);
    }
  }
}
