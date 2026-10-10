import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface EscapeHatchesStackProps extends cdk.StackProps {
  /**
   * Logical ID of a bucket that already exists in the target account and was
   * created by an older template (or by hand). Giving the L1 *that* logical ID
   * lets `cdk import` adopt it without replacement.
   */
  readonly legacyBucketLogicalId?: string;
}

/**
 * The escape-hatch ladder, one rung per resource, in order of preference:
 *
 *   1. L2 prop                      — always first; nothing below survives a refactor as well
 *   2. `defaultChild as CfnX`       — typed L1 property the L2 does not expose
 *   3. `addPropertyOverride(path)`  — any Properties path, modelled or not; array indices allowed
 *   4. `addOverride(path)`          — anything outside Properties: Metadata, UpdateReplacePolicy, DependsOn, Condition
 *   5. `addPropertyDeletionOverride`— remove something the L2 insists on rendering
 *   6. `node.tryRemoveChild`        — drop a whole child construct the L2 created
 *   7. raw `CfnResource`            — a type your aws-cdk-lib does not know yet
 *   8. custom resource              — behaviour CloudFormation does not have (see custom-resources.ts)
 *
 * Every rung down loses type-safety and gains blast radius. Each use below has a
 * comment saying why the rungs above were not enough.
 */
export class EscapeHatchesStack extends cdk.Stack {
  readonly bucket: s3.Bucket;
  readonly legacyBucket: s3.CfnBucket;
  readonly securityGroup: ec2.SecurityGroup;
  readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: EscapeHatchesStackProps = {}) {
    super(scope, id, props);

    // ---- rung 1: the L2 -------------------------------------------------------
    this.bucket = new s3.Bucket(this, 'Reports', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    });

    // ---- rung 2: defaultChild → typed L1 ---------------------------------------
    // `Bucket` has no prop for S3 Storage Class Analysis. The L1 does. Assigning
    // through the typed L1 keeps compile-time checking of the property shape.
    // (The export goes to a second bucket: a bucket exporting to itself is a
    // circular dependency that the built-in CloudFormation validator rejects.)
    const analytics = new s3.Bucket(this, 'Analytics', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });
    const cfnBucket = this.bucket.node.defaultChild as s3.CfnBucket;
    cfnBucket.analyticsConfigurations = [
      {
        id: 'whole-bucket',
        storageClassAnalysis: {
          dataExport: { outputSchemaVersion: 'V_1', destination: { bucketArn: analytics.bucketArn, format: 'CSV', prefix: 'analytics/' } },
        },
      },
    ];

    // ---- rung 3: addPropertyOverride ------------------------------------------
    // The L2 rendered OwnershipControls.Rules[0].ObjectOwnership = BucketOwnerPreferred.
    // Overrides are applied to the *rendered JSON*, so the path may index arrays
    // and may name properties this aws-cdk-lib version has never heard of.
    cfnBucket.addPropertyOverride('OwnershipControls.Rules.0.ObjectOwnership', 'BucketOwnerEnforced');

    // ---- rung 4: addOverride (outside Properties) -----------------------------
    // Metadata is free-form and survives to the deployed stack: use it for
    // ownership, ticket links, or cfn-lint directives.
    cfnBucket.addOverride('Metadata.cdk-mastery.owner', 'platform-team');
    cfnBucket.addOverride('Metadata.cdk-mastery.escape-hatches', ['analyticsConfigurations', 'OwnershipControls override']);
    // Replacement policy without the L2's applyRemovalPolicy (which also sets DeletionPolicy):
    // "keep the old bucket if CloudFormation ever needs to replace it, but delete on stack delete".
    cfnBucket.addOverride('UpdateReplacePolicy', 'Retain');

    // ---- rung 5: addPropertyDeletionOverride ------------------------------------
    // A SecurityGroup L2 always renders an allow-all egress rule (allowAllOutbound
    // defaults to true). Some orgs manage egress rules out-of-band (a firewall
    // team's automation). Deleting the property lets CloudFormation fall back to
    // AWS's default (which is *also* allow-all) without CDK owning the rule —
    // drift-free for the external automation.
    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 0, subnetConfiguration: [{ name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }] });
    this.securityGroup = new ec2.SecurityGroup(this, 'WorkerSg', { vpc, description: 'egress managed externally' });
    (this.securityGroup.node.defaultChild as ec2.CfnSecurityGroup).addPropertyDeletionOverride('SecurityGroupEgress');

    // ---- rung 6: node.tryRemoveChild -------------------------------------------
    // `grantRead` attaches an inline DefaultPolicy to the function's role. When
    // the role's permissions are owned by another system (an IAM policy stack
    // that attaches managed policies by role name), the inline policy is an
    // unwanted second source of truth. Removing the child removes the resource.
    this.fn = new lambda.Function(this, 'Worker', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({ ok: true });'),
      vpc,
      securityGroups: [this.securityGroup],
    });
    this.bucket.grantRead(this.fn);
    const removed = this.fn.role!.node.tryRemoveChild('DefaultPolicy');
    if (!removed) throw new Error('expected grantRead to have created DefaultPolicy');
    // Replace with the externally-owned policy, attached by name (no resource created for it).
    this.fn.role!.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyName(this, 'ExternalWorkerPolicy', 'orders-worker-runtime'));

    // ---- overrideLogicalId: adopt an existing resource ------------------------
    // A bucket created by an old template has logical ID `LegacyAssetsBucket`.
    // Rename the construct all you like; pin the logical ID so CloudFormation sees
    // the same resource. Combined with RETAIN policies and `cdk import` this is
    // how a resource moves into CDK with zero replacement.
    this.legacyBucket = new s3.CfnBucket(this, 'AdoptedAssets', {
      bucketName: 'orders-legacy-assets',
      publicAccessBlockConfiguration: { blockPublicAcls: true, blockPublicPolicy: true, ignorePublicAcls: true, restrictPublicBuckets: true },
    });
    this.legacyBucket.overrideLogicalId(props.legacyBucketLogicalId ?? 'LegacyAssetsBucket');
    this.legacyBucket.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // ---- rung 7: raw CfnResource ----------------------------------------------
    // For a resource type newer than your aws-cdk-lib (no generated L1 yet) you
    // write the CloudFormation directly. The type used here *does* have an L1
    // (`ssm.CfnParameter`) — the point is the mechanics, and the template stays
    // deployable. Properties are passed exactly as CloudFormation expects them.
    new cdk.CfnResource(this, 'RawParameter', {
      type: 'AWS::SSM::Parameter',
      properties: {
        Name: '/cdk-mastery/10/raw-resource',
        Type: 'String',
        Value: 'written by a raw CfnResource',
      },
    });
  }
}
