/**
 * Exercise 1 — harden the bucket.
 *
 * Add public-access prevention, a lifecycle rule that deletes non-current
 * object versions after the tier's `logRetentionDays`, and make `force_destroy`
 * and the lifecycle rule follow the tier rather than being hard-coded.
 */
import { TerraformOutput, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { environmentFor, mandatoryTags, resourceName } from '@cdk-mastery/shared';
import { gcpProject, gcpRegion } from '../gcp-config';

export interface HardenedHelloStackProps {
  readonly tier: string;
  readonly project?: string;
  readonly region?: string;
}

export class HardenedHelloStack extends TerraformStack {
  readonly bucket: StorageBucket;

  constructor(scope: Construct, id: string, props: HardenedHelloStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    new GoogleProvider(this, 'Google', { project: props.project ?? gcpProject(), region: props.region ?? gcpRegion() });

    this.bucket = new StorageBucket(this, 'Artifacts', {
      name: resourceName({ org: 'cdkm', service: 'hello', env: tier.name, component: 'artifacts' }),
      location: 'US',
      uniformBucketLevelAccess: true,
      // 'enforced' makes allUsers/allAuthenticatedUsers grants fail at the API,
      // regardless of what IAM says. Org policy can set it fleet-wide; setting it
      // here too makes the intent reviewable in the PR.
      publicAccessPrevention: 'enforced',
      versioning: { enabled: true },
      forceDestroy: !tier.retainStatefulResources,
      lifecycleRule: [
        {
          // Versioning without a lifecycle rule is a slow-motion cost leak: every
          // overwrite keeps the old generation forever.
          action: { type: 'Delete' },
          condition: { daysSinceNoncurrentTime: tier.logRetentionDays, withState: 'ARCHIVED' },
        },
        {
          // Keep at most 3 non-current versions per object no matter their age.
          action: { type: 'Delete' },
          condition: { numNewerVersions: 3, withState: 'ARCHIVED' },
        },
      ],
      labels: mandatoryTags(tier, 'hello'),
    });

    new TerraformOutput(this, 'BucketName', { value: this.bucket.name });
  }
}
