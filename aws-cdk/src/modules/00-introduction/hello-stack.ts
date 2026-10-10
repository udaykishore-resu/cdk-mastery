import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { resourceName } from '@cdk-mastery/shared';
import { LifecyclePhases } from './lifecycle-phases';

export interface HelloStackProps extends cdk.StackProps {
  /** Environment tier name used in resource names. Kept as a plain string so this stack stays env-agnostic. */
  readonly tier: string;
}

/**
 * The smallest stack that still shows every layer of the model:
 *
 *   App (root)
 *   └── Stack "M00-Hello"                  -> one CloudFormation template
 *       ├── Bucket "Artifacts"  (L2)       -> AWS::S3::Bucket  (+ a bucket policy because enforceSSL)
 *       │   └── CfnBucket "Resource" (L1)  -> the actual "Resources.ArtifactsXXXX" entry
 *       ├── StringParameter "Version" (L2) -> AWS::SSM::Parameter
 *       ├── LifecyclePhases "Phases"       -> a probe that records construct→prepare→validate→synth
 *       └── CfnOutput "BucketName"         -> Outputs.BucketName
 *
 * Nothing here is env-specific: no `env` is passed, so `Stack.of(this).region` is the
 * token `{ "Ref": "AWS::Region" }` and the same template deploys anywhere.
 */
export class HelloStack extends cdk.Stack {
  readonly bucket: s3.Bucket;
  readonly phases: LifecyclePhases;

  constructor(scope: Construct, id: string, props: HelloStackProps = { tier: 'dev' }) {
    super(scope, id, props);

    // An L2. Its constructor creates a child L1 (`Resource`) plus, because of
    // `enforceSSL`, a second L1 (`Policy/Resource`) — two CloudFormation resources
    // from one line of code. Module 01 dissects this.
    this.bucket = new s3.Bucket(this, 'Artifacts', {
      bucketName: resourceName({ org: 'cdkm', service: 'hello', env: props.tier, component: 'artifacts' }),
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    new ssm.StringParameter(this, 'Version', {
      parameterName: `/cdk-mastery/${props.tier}/hello/version`,
      stringValue: '1.0.0',
    });

    this.phases = new LifecyclePhases(this, 'Phases');

    // Outputs are the only "return value" a CloudFormation stack has. Module 02 shows
    // how CDK uses them under the hood for cross-stack references.
    new cdk.CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
  }
}
