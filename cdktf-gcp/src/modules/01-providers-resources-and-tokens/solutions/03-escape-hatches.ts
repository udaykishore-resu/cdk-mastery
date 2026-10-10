/**
 * Exercise 3 — the escape hatches, in order of how often you should need them.
 *
 *   overrideLogicalId  keep a legacy address so state does not see a rename
 *   addOverride        write JSON the typed bindings cannot express (or do not know yet)
 *   importFrom         adopt an existing resource with a Terraform 1.5+ `import` block
 *   TerraformResource  a resource type the bindings do not have at all
 *
 * Build a stack that adopts a pre-existing bucket under its old HCL address
 * `google_storage_bucket.legacy`, sets an attribute through a raw override, and
 * declares a resource type the prebuilt provider does not know.
 */
import { TerraformOutput, TerraformResource, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { configureProviders } from '../providers';

export interface EscapeHatchStackProps {
  /** Name of a bucket that already exists in the project and should be adopted. */
  readonly existingBucketName: string;
  readonly project?: string;
}

export class EscapeHatchStack extends TerraformStack {
  readonly legacy: StorageBucket;

  constructor(scope: Construct, id: string, props: EscapeHatchStackProps) {
    super(scope, id);
    const { google } = configureProviders(this, { project: props.project });

    this.legacy = new StorageBucket(this, 'AdoptedBucket', {
      name: props.existingBucketName,
      location: 'US',
      uniformBucketLevelAccess: true,
    });
    // The HCL this replaced called it `google_storage_bucket.legacy`. Keeping the
    // logical id means `terraform plan` sees no address change. Without this,
    // the address would be `google_storage_bucket.AdoptedBucket` and you would
    // need `moveTo` (module 02) or `terraform state mv`.
    this.legacy.overrideLogicalId('legacy');

    // Adopt it: synth emits an `import { to, id }` block; the next apply reads
    // the real bucket into state instead of trying to create it. Remove the call
    // once applied — a second apply with the block present is a no-op but noisy.
    this.legacy.importFrom(props.existingBucketName, google);

    // Raw override: the provider accepts `rpo = "ASYNC_TURBO"` for dual-region
    // buckets; here we pretend the bindings do not have it. Paths are dotted;
    // arrays are written as JSON arrays.
    this.legacy.addOverride('rpo', 'DEFAULT');
    this.legacy.addOverride('timeouts.create', '10m');

    // A resource type the bindings lack (imagine a provider newer than the
    // package). `TerraformResource` takes the raw type; attributes go through
    // `addOverride` because there is no typed surface at all.
    const raw = new TerraformResource(this, 'Notification', {
      terraformResourceType: 'google_storage_notification',
      provider: google,
      dependsOn: [this.legacy],
    });
    raw.addOverride('bucket', this.legacy.name);
    raw.addOverride('payload_format', 'JSON_API_V1');
    raw.addOverride('topic', 'projects/example/topics/bucket-events');

    new TerraformOutput(this, 'adopted_bucket_self_link', { value: this.legacy.selfLink });
    // Reading an attribute of a raw resource: the token API is the same.
    new TerraformOutput(this, 'notification_id', { value: raw.getStringAttribute('notification_id') });
  }
}
