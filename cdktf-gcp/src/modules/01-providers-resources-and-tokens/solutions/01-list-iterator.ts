/**
 * Exercise 1 — `for_each` over a list vs `count`.
 *
 * Create one bucket per region from a plain string list with
 * `TerraformIterator.fromList`, and N numbered "shard" buckets with
 * `TerraformCount`. Then explain in the README why removing the *first*
 * region from the list is harmless with `for_each` and destructive with
 * `count` (the test below shows the addresses that make the difference).
 */
import { Fn, TerraformCount, TerraformIterator, TerraformOutput, TerraformStack, propertyAccess } from 'cdktf';
import { Construct } from 'constructs';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { environmentFor, regionShortCode, resourceName } from '@cdk-mastery/shared';
import { configureProviders } from '../providers';

export interface RegionalBucketsStackProps {
  readonly tier: string;
  readonly regions: string[];
  readonly shards: number;
  readonly project?: string;
}

export class RegionalBucketsStack extends TerraformStack {
  readonly perRegion: StorageBucket;
  readonly shards: StorageBucket;

  constructor(scope: Construct, id: string, props: RegionalBucketsStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    configureProviders(this, { project: props.project });

    // for_each over a list: CDKTF wraps it in `toset()`, so the instance keys are
    // the *values* ("us-central1", ...). Removing an element removes exactly
    // that instance; nothing else moves.
    const regions = TerraformIterator.fromList(props.regions);
    this.perRegion = new StorageBucket(this, 'PerRegion', {
      forEach: regions,
      // `regions.value` is `each.value`. Naming needs the short code, which is a
      // TypeScript function — it cannot run on a token. So the name is built
      // with Terraform functions instead: replace("us-central1", "-", "") is the
      // closest Terraform can get without a lookup table.
      name: Fn.format('%s-%s', [
        resourceName({ org: 'cdkm', service: 'tokens', env: tier.name, component: 'regional' }),
        Fn.replace(regions.value, '-', ''),
      ]),
      location: regions.value,
      uniformBucketLevelAccess: true,
      forceDestroy: !tier.retainStatefulResources,
    });

    // count: instances are addressed by position (`[0]`, `[1]`, ...). Removing
    // the first shard renumbers every other one, and Terraform's plan is
    // "destroy N, recreate N-1". Use count only when instances are truly
    // interchangeable — which numbered shards are.
    const count = TerraformCount.of(props.shards);
    this.shards = new StorageBucket(this, 'Shard', {
      count,
      name: Fn.format('%s-%d', [
        resourceName({ org: 'cdkm', service: 'tokens', env: tier.name, component: 'shard' }),
        count.index,
      ]),
      location: 'US',
      uniformBucketLevelAccess: true,
      forceDestroy: !tier.retainStatefulResources,
    });

    new TerraformOutput(this, 'regional_bucket_names', {
      value: propertyAccess(Fn.values(this.perRegion.fqn), ['*', 'name']),
    });
    new TerraformOutput(this, 'shard_bucket_names', {
      value: propertyAccess(this.shards.fqn, ['*', 'name']),
    });
    // Static, TypeScript-side facts are still the best place for what TypeScript knows.
    new TerraformOutput(this, 'region_short_codes', {
      value: Fn.join(',', props.regions.map(regionShortCode)),
    });
  }
}
