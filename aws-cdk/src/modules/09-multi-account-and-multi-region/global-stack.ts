import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { EnvironmentTier, resourceName } from '@cdk-mastery/shared';
import { Construct } from 'constructs';

export interface GlobalStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
}

/**
 * Resources that *must* live in us-east-1 regardless of where the workload runs.
 *
 * A WAFv2 WebACL with `scope: CLOUDFRONT` is the canonical example: CloudFront
 * is a global service whose control plane is in us-east-1, so its WebACL (and
 * its ACM certificate) must be created there. The regional stack in us-west-2
 * needs the ACL's ARN — a cross-region reference, which CloudFormation cannot
 * express natively (`Fn::ImportValue` is region-scoped). See `PlatformStage`
 * for how CDK bridges it.
 *
 * It exposes two kinds of value on purpose:
 *   - `webAclArn`: an **L1 attribute** (`CfnWebACL.attrArn`, a plain `Fn::GetAtt`).
 *     In aws-cdk-lib 2.269 such references are wired across regions automatically.
 *   - `edgeLogsBucket`: an **L2 `Resource`** whose `bucketArn`/`bucketName` go
 *     through `Resource.getResourceArnAttribute`. Across environments those
 *     substitute the *physical name* unless the consuming/producing stacks set
 *     `crossRegionReferences: true` — without it and without an explicit name you
 *     get "Cannot use resource in a cross-environment fashion". The tests show
 *     all three outcomes.
 *
 * The stack refuses to be placed anywhere but us-east-1: a concrete-region
 * check at construction is cheaper than a CloudFormation error 10 minutes in.
 */
export class GlobalStack extends cdk.Stack {
  readonly webAclArn: string;
  readonly edgeLogsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: GlobalStackProps) {
    super(scope, id, props);

    if (!cdk.Token.isUnresolved(this.region) && this.region !== 'us-east-1') {
      throw new Error(`GlobalStack must be deployed to us-east-1 (CLOUDFRONT-scoped WAF); got ${this.region}`);
    }

    const acl = new wafv2.CfnWebACL(this, 'EdgeAcl', {
      name: resourceName({ org: 'revan', service: 'platform', env: props.tier.name, component: 'edge-acl' }),
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: 'edge-acl' },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 0,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: 'common-rules' },
        },
      ],
    });
    this.webAclArn = acl.attrArn;

    // Standard-logging bucket for CloudFront; no explicit bucketName, so a cross-region
    // consumer *needs* crossRegionReferences (see RegionalStack / tests).
    this.edgeLogsBucket = new s3.Bucket(this, 'EdgeLogs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED, // CloudFront standard logs need ACLs enabled
      removalPolicy: props.tier.retainStatefulResources ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [{ expiration: cdk.Duration.days(props.tier.logRetentionDays) }],
    });
  }
}
