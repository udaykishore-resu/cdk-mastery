import { Construct } from 'constructs';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { StorageBucketIamMember } from '@cdktf/provider-google/lib/storage-bucket-iam-member';

export interface PrivateBucketProps {
  readonly name: string;
  readonly location: string;
  /** Principals (`serviceAccount:...`, `group:...`) granted objectViewer. Public principals are rejected. */
  readonly readers?: string[];
  readonly labels?: Record<string, string>;
}

/**
 * A construct small enough to test in isolation with `Testing.synthScope`, and
 * with enough opinions (defaults + validation) that there is something to test:
 *
 *   - uniform access and enforced public-access prevention, always;
 *   - versioning on;
 *   - readers become one `google_storage_bucket_iam_member` each (additive; never a binding);
 *   - `allUsers` / `allAuthenticatedUsers` throw at construction — the construct's
 *     own contract, independent of any aspect.
 */
export class PrivateBucket extends Construct {
  readonly bucket: StorageBucket;
  readonly members: StorageBucketIamMember[] = [];

  constructor(scope: Construct, id: string, props: PrivateBucketProps) {
    super(scope, id);
    const readers = props.readers ?? [];
    const bad = readers.filter((r) => r === 'allUsers' || r === 'allAuthenticatedUsers');
    if (bad.length > 0) {
      throw new Error(`PrivateBucket ${id}: public principals are not allowed as readers (${bad.join(', ')})`);
    }

    this.bucket = new StorageBucket(this, 'Bucket', {
      name: props.name,
      location: props.location,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: 'enforced',
      versioning: { enabled: true },
      labels: props.labels,
    });

    readers.forEach((member, i) => {
      this.members.push(
        new StorageBucketIamMember(this, `Reader${i}`, {
          bucket: this.bucket.name,
          role: 'roles/storage.objectViewer',
          member,
        }),
      );
    });
  }
}
