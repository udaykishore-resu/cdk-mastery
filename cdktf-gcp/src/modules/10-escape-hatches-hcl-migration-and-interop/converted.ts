import { Fn, GcsBackend, TerraformLocal, TerraformOutput, TerraformStack, TerraformVariable, VariableType, ref } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { StorageBucketIamMember } from '@cdktf/provider-google/lib/storage-bucket-iam-member';

export interface ConvertedStackProps {
  /** Keep the GCS backend from the HCL (needs the bucket to exist). Off for offline synth. */
  readonly keepBackend?: boolean;
}

/**
 * `legacy/main.tf`, hand-converted. Line for line what `cdktf convert` emits,
 * with three deliberate corrections (see README "what convert gets wrong"):
 *
 *   1. Logical ids are pinned to the HCL names with `overrideLogicalId`, so the
 *      Terraform addresses (`google_storage_bucket.assets`) are byte-identical
 *      and the existing state applies with **zero changes**. `cdktf convert`
 *      uses the HCL name as the construct id, which produces the same address
 *      for top-level resources — but the moment you wrap anything in a
 *      construct the address changes and Terraform wants to destroy+create.
 *      Pinning makes the intent explicit and survives refactors.
 *   2. `validation` on the variable is kept (convert drops it in some versions).
 *   3. `local.labels` becomes a `TerraformLocal` so the rendered JSON keeps the
 *      `locals` block; plain TypeScript constants would inline the values,
 *      which is fine functionally but changes the diff a reviewer sees.
 */
export class ConvertedStack extends TerraformStack {
  readonly bucket: StorageBucket;
  readonly reader: ServiceAccount;

  constructor(scope: Construct, id: string, props: ConvertedStackProps = {}) {
    super(scope, id);

    const projectId = new TerraformVariable(this, 'ProjectId', {
      type: VariableType.STRING,
      description: 'Project that owns the legacy assets bucket',
    });
    projectId.overrideLogicalId('project_id');

    const environment = new TerraformVariable(this, 'Environment', {
      type: VariableType.STRING,
      default: 'dev',
      validation: [
        {
          // `ref('var.environment')` keeps the reference an expression inside the
          // variable's own validation block (a token would try to resolve the variable).
          condition: Fn.contains(['dev', 'staging', 'prod'], ref('var.environment')),
          errorMessage: 'environment must be dev, staging or prod',
        },
      ],
    });
    environment.overrideLogicalId('environment');

    const labels = new TerraformLocal(this, 'Labels', { environment: environment.stringValue, 'managed-by': 'terraform' });
    labels.overrideLogicalId('labels');

    new GoogleProvider(this, 'Google', { project: projectId.stringValue, region: 'us-central1' });
    if (props.keepBackend) {
      new GcsBackend(this, { bucket: 'cdkm-tf-state', prefix: 'legacy/assets' });
    }

    this.bucket = new StorageBucket(this, 'Assets', {
      name: `cdkm-legacy-assets-${environment.stringValue}`,
      location: 'US',
      uniformBucketLevelAccess: true,
      labels: labels.asStringMap,
      versioning: { enabled: true },
      lifecycleRule: [{ condition: { numNewerVersions: 5 }, action: { type: 'Delete' } }],
    });
    this.bucket.overrideLogicalId('assets');

    this.reader = new ServiceAccount(this, 'AssetsReader', {
      accountId: 'legacy-assets-reader',
      displayName: 'Legacy assets reader',
    });
    this.reader.overrideLogicalId('assets_reader');

    const member = new StorageBucketIamMember(this, 'Reader', {
      bucket: this.bucket.name,
      role: 'roles/storage.objectViewer',
      member: `serviceAccount:${this.reader.email}`,
    });
    member.overrideLogicalId('reader');

    const bucketOut = new TerraformOutput(this, 'AssetsBucket', {
      value: this.bucket.name,
      description: 'Consumed by newer stacks through terraform_remote_state',
    });
    bucketOut.overrideLogicalId('assets_bucket');
    const readerOut = new TerraformOutput(this, 'ReaderEmail', { value: this.reader.email });
    readerOut.overrideLogicalId('reader_email');
  }
}
