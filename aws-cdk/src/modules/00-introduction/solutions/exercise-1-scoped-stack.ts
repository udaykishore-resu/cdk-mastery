import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Exercise 1 — group constructs in an intermediate scope and watch the logical ID move.
 *
 * `HelloStack` puts `Artifacts` directly under the stack, so its L1 lives at
 * `M00-Hello/Artifacts/Resource` and gets logical ID `Artifacts<hash>`. Wrapping the same
 * bucket in a plain `Construct` called `Storage` changes the path to
 * `<stack>/Storage/Artifacts/Resource`, which changes the logical ID to
 * `StorageArtifacts<hash>`. To CloudFormation that is a *different resource*: deploying
 * this change over the original stack would create a new bucket and delete the old one.
 *
 * Lesson: construct paths are part of your deployed state. Refactoring the tree is a
 * data-migration decision, not a code-style decision. Module 01 shows `overrideLogicalId`,
 * the escape hatch for exactly this situation.
 */
export class Storage extends Construct {
  readonly bucket: s3.Bucket;
  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.bucket = new s3.Bucket(this, 'Artifacts', { removalPolicy: cdk.RemovalPolicy.DESTROY });
  }
}

export class ScopedHelloStack extends cdk.Stack {
  readonly storage: Storage;
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    this.storage = new Storage(this, 'Storage');
  }
}
