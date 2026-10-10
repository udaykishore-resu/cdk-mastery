import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BundledConfigAsset } from './assets';
import { ParameterWriter, SlowResource } from './custom-resources';

/**
 * Hosts the two custom resources and the bundled asset so `index.ts` can keep
 * one stack per concept. Everything here is env-agnostic.
 */
export class CustomResourcesStack extends cdk.Stack {
  readonly slow: SlowResource;
  readonly writer: ParameterWriter;
  readonly config: BundledConfigAsset;

  constructor(scope: Construct, id: string, props: cdk.StackProps = {}) {
    super(scope, id, props);

    this.slow = new SlowResource(this, 'Slow', { name: 'orders-index', waitSeconds: 20 });
    this.writer = new ParameterWriter(this, 'Writer', {
      parameterName: '/cdk-mastery/10/slow-result',
      // A custom-resource attribute flowing into another custom resource's
      // properties: CloudFormation orders them by the reference.
      value: this.slow.result,
    });
    this.config = new BundledConfigAsset(this, 'Config', { sourcePath: path.join(__dirname, 'assets', 'config') });

    new cdk.CfnOutput(this, 'SlowResult', { value: this.slow.result });
    new cdk.CfnOutput(this, 'ConfigObjectUrl', { value: this.config.asset.s3ObjectUrl });
  }
}
