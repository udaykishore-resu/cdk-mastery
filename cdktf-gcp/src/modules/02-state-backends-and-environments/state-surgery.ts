import { TerraformIterator, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { ComputeNetwork } from '@cdktf/provider-google/lib/compute-network';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { environmentFor, resourceName } from '@cdk-mastery/shared';
import { gcpProject, gcpRegion } from './gcp-config';

export interface RefactorStackProps {
  readonly tier: string;
  /** Name of a bucket created outside Terraform that this stack should adopt. */
  readonly adoptBucketName: string;
  readonly project?: string;
}

/**
 * State surgery *in code*, the way Terraform ≥ 1.5 wants it:
 *
 *   moved { from, to }   — rename or restructure without destroy/create
 *   import { to, id }    — adopt an existing resource into state
 *
 * Both are declarative and reviewable in the same PR as the refactor, and both
 * are idempotent (a second apply is a no-op). Compare the imperative tools:
 *
 *   terraform state mv  google_compute_network.legacy_network google_compute_network.Vpc
 *   terraform import    google_storage_bucket.Adopted my-existing-bucket
 *   terraform state rm  google_storage_bucket.Orphan      # forget, do not destroy
 *   terraform state pull > state.json; edit; terraform state push state.json   # last resort
 *
 * Those mutate state outside of any plan and leave no trace in git. Use them
 * for one-off repairs; use `moveTo`/`importFrom` for refactors.
 */
export class RefactorStack extends TerraformStack {
  readonly network: ComputeNetwork;
  readonly buckets: StorageBucket;
  readonly adopted: StorageBucket;

  constructor(scope: Construct, id: string, props: RefactorStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    const google = new GoogleProvider(this, 'Google', { project: props.project ?? gcpProject(), region: gcpRegion() });

    // 1. Rename. The HCL (or an earlier CDKTF version) called this
    //    `google_compute_network.legacy_network`. The new construct id is `Vpc`;
    //    `moveFromId` emits `moved { from = …legacy_network, to = …Vpc }`.
    this.network = new ComputeNetwork(this, 'Vpc', {
      name: resourceName({ org: 'cdkm', service: 'state', env: tier.name, component: 'refactor-vpc' }),
      autoCreateSubnetworks: false,
    });
    this.network.moveFromId('google_compute_network.legacy_network');

    // 2. Restructure: a single resource becomes one instance of a for_each map.
    //    The *target* declares a move target; the *old* resource points at it with
    //    an index. The old construct is not rendered as a resource any more —
    //    only its `moved` block survives.
    const keys = TerraformIterator.fromList(['raw', 'curated']);
    this.buckets = new StorageBucket(this, 'Buckets', {
      forEach: keys,
      name: `${resourceName({ org: 'cdkm', service: 'state', env: tier.name, component: 'refactor' })}-${keys.value}`,
      location: 'US',
      uniformBucketLevelAccess: true,
    });
    this.buckets.addMoveTarget('buckets-by-key');
    const rawBucket = new StorageBucket(this, 'RawBucket', {
      name: `${resourceName({ org: 'cdkm', service: 'state', env: tier.name, component: 'refactor' })}-raw`,
      location: 'US',
      uniformBucketLevelAccess: true,
    });
    rawBucket.moveTo('buckets-by-key', 'raw');

    // 3. Adopt. The bucket exists (created by a console click, a script, or a
    //    previous team). `importFrom` emits an `import` block; the first apply
    //    reads it into state; from then on the config manages it. The config
    //    must match reality closely enough that the post-import plan is empty.
    this.adopted = new StorageBucket(this, 'Adopted', {
      name: props.adoptBucketName,
      location: 'US',
      uniformBucketLevelAccess: true,
    });
    this.adopted.importFrom(props.adoptBucketName, google);
  }
}
