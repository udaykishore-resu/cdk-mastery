import { TerraformOutput, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { environmentFor, mandatoryTags, resourceName } from '@cdk-mastery/shared';
import { gcpProject, gcpRegion } from './gcp-config';

export interface HelloStackProps {
  /** Environment tier name ("dev" | "staging" | "prod"); drives the bucket name, labels and force_destroy. */
  readonly tier: string;
  /** GCP project id. Defaults to `CDKM_GCP_PROJECT` or `cdk-mastery-demo`. */
  readonly project?: string;
  /** Provider default region. Defaults to `CDKM_GCP_REGION` or `us-central1`. */
  readonly region?: string;
}

/**
 * The smallest stack that still exercises every layer of the model:
 *
 *   App (root; owns the output directory)
 *   └── TerraformStack "m00-hello"          -> cdktf.out/stacks/m00-hello/cdk.tf.json
 *       ├── GoogleProvider "Google"          -> provider.google[0] + terraform.required_providers.google
 *       ├── StorageBucket  "Artifacts"       -> resource.google_storage_bucket.Artifacts
 *       └── TerraformOutput "BucketName"     -> output.BucketName
 *
 * There is no L1/L2 split as in AWS CDK: every class in `@cdktf/provider-google`
 * maps 1:1 to a Terraform resource type and its schema. The construct *is* the
 * resource block. Abstraction (what AWS CDK calls L2/L3) is something you write
 * yourself (module 05) or fetch from the Terraform Registry as a module.
 */
export class HelloStack extends TerraformStack {
  readonly bucket: StorageBucket;

  constructor(scope: Construct, id: string, props: HelloStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    const project = props.project ?? gcpProject();
    const region = props.region ?? gcpRegion();

    // Providers are per-stack in CDKTF. Each TerraformStack is a separate
    // Terraform root module with its own state, so each one needs its own
    // provider block; there is no app-wide provider.
    new GoogleProvider(this, 'Google', { project, region });

    this.bucket = new StorageBucket(this, 'Artifacts', {
      name: resourceName({ org: 'cdkm', service: 'hello', env: tier.name, component: 'artifacts' }),
      location: 'US',
      // Uniform bucket-level access disables per-object ACLs so IAM is the only
      // authorisation path. Google warns you if you leave it off; make it the default.
      uniformBucketLevelAccess: true,
      versioning: { enabled: true },
      // `force_destroy` lets `terraform destroy` delete a non-empty bucket. In
      // prod that is exactly the accident you want the API to refuse.
      forceDestroy: !tier.retainStatefulResources,
      labels: mandatoryTags(tier, 'hello'),
    });

    // Outputs are the *only* return value a Terraform root module has. Module 02
    // shows how CDKTF uses them under the hood for cross-stack references.
    new TerraformOutput(this, 'BucketName', {
      value: this.bucket.name,
      description: 'Name of the artifacts bucket',
    });
    new TerraformOutput(this, 'BucketUrl', { value: this.bucket.url });
  }
}
