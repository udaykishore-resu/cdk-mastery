import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { regionShortCode, resourceName } from '@cdk-mastery/shared';
import { Construct } from 'constructs';
import { DeploymentTarget } from './targets';

export interface RegionalStackProps extends cdk.StackProps {
  readonly target: DeploymentTarget;
  /**
   * ARN of the CloudFront WebACL from the global (us-east-1) stack. Passing a
   * token from another stack in another region is what triggers CDK's
   * cross-region reference machinery; both stacks need concrete envs.
   */
  readonly edgeWebAclArn?: string;
  /** ARN of the global stack's L2 logs bucket — exercises the `Resource` cross-environment path. */
  readonly edgeLogsBucketArn?: string;
}

/**
 * The per-region workload stack. Three things it demonstrates:
 *
 *  1. `Stack.of(this).account` / `.region` are *tokens* for env-agnostic stacks
 *     and *strings* for stacks with a concrete env. Guard with
 *     `Token.isUnresolved` before comparing — the check below is a real
 *     safety net against "deployed prod config into the dev account".
 *  2. `Aws.ACCOUNT_ID` / `Aws.REGION` are pseudo-parameters resolved by
 *     CloudFormation at deploy time (`{ "Ref": "AWS::AccountId" }`). Use them in
 *     names that must be unique per env without baking the account into code.
 *  3. Consuming a cross-region value: the WebACL ARN is stored in an SSM
 *     parameter here so regional consumers (a CloudFront distribution stack, a
 *     runbook) can read it without another cross-stack edge.
 */
export class RegionalStack extends cdk.Stack {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: RegionalStackProps) {
    super(scope, id, props);
    const { target } = props;

    // (1) Concrete-env assertion. `this.account` is a string when `env.account`
    // was given, a token like `${Token[AWS.AccountId.3]}` otherwise.
    if (!cdk.Token.isUnresolved(this.account) && this.account !== target.env.account) {
      throw new Error(`RegionalStack for tier "${target.tier.name}" must deploy to account ${target.env.account}, got ${this.account}`);
    }
    if (!cdk.Token.isUnresolved(this.region) && this.region !== target.env.region) {
      throw new Error(`RegionalStack for tier "${target.tier.name}" must deploy to region ${target.env.region}, got ${this.region}`);
    }

    // (2) Deploy-time tokens in a globally-unique bucket name. The code never
    // contains "222222222222"; the template contains {"Ref":"AWS::AccountId"}.
    this.bucket = new s3.Bucket(this, 'Data', {
      bucketName: `${resourceName({ org: 'revan', service: 'platform', env: target.tier.name, component: 'data' })}-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: target.tier.retainStatefulResources,
      removalPolicy: target.tier.retainStatefulResources ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // (3) Cross-region consumer.
    if (props.edgeWebAclArn) {
      new ssm.StringParameter(this, 'EdgeAclArn', {
        parameterName: `/cdk-mastery/platform/${target.tier.name}/edge-acl-arn`,
        stringValue: props.edgeWebAclArn,
        description: 'CloudFront WebACL ARN owned by the us-east-1 global stack',
      });
    }

    if (props.edgeLogsBucketArn) {
      new ssm.StringParameter(this, 'EdgeLogsBucketArn', {
        parameterName: `/cdk-mastery/platform/${target.tier.name}/edge-logs-bucket-arn`,
        stringValue: props.edgeLogsBucketArn,
      });
    }

    new ssm.StringParameter(this, 'RegionCode', {
      parameterName: `/cdk-mastery/platform/${target.tier.name}/region-code`,
      stringValue: regionShortCode(target.env.region),
    });
  }
}
