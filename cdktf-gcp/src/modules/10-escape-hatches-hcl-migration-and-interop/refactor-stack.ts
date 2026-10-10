import { TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { PubsubTopic } from '@cdktf/provider-google/lib/pubsub-topic';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { environmentFor, resourceName } from '@cdk-mastery/shared';
import { gcpProject, gcpRegion } from './gcp-config';

export interface RefactorStackProps {
  readonly tier: string;
  readonly project?: string;
  readonly region?: string;
}

/**
 * Three state-surgery operations, each rendered as a Terraform block so the
 * *plan* shows "no changes" or "1 to import" instead of "1 to destroy, 1 to add":
 *
 *   importFrom(id)       -> `import { to = ..., id = ... }`   adopt an existing object
 *   addMoveTarget/moveTo -> `moved { from = ..., to = ... }`   rename between two constructs
 *   moveFromId(address)  -> `moved { from = ..., to = ... }`   rename when the old construct is gone
 *
 * `moved`/`import` are declarative (Terraform >= 1.5): they live in the config,
 * are applied by `terraform apply`, and are idempotent, so they replace the
 * imperative `terraform state mv` / `terraform import` that had to be run by a
 * human against the right state at the right moment. Delete the block after
 * the apply that used it; leaving it is harmless but noisy.
 */
export class RefactorStack extends TerraformStack {
  readonly adopted: StorageBucket;
  readonly renamed: PubsubTopic;
  readonly reader: ServiceAccount;

  constructor(scope: Construct, id: string, props: RefactorStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    const project = props.project ?? gcpProject();
    const region = props.region ?? gcpRegion();
    new GoogleProvider(this, 'Google', { project, region });
    const name = (component: string) => resourceName({ org: 'cdkm', service: 'refactor', env: tier.name, component });

    // 1. Adopt a bucket that was created by hand (or by another tool). The
    //    config must match the real object closely enough that the first plan
    //    after import is clean; anything different becomes an in-place update
    //    (or a replacement — check the plan before applying).
    this.adopted = new StorageBucket(this, 'Adopted', {
      name: name('adopted'),
      location: region.toUpperCase(),
      uniformBucketLevelAccess: true,
    });
    // Import id format is per resource type; for buckets it is the bucket name
    // (optionally `projects/<p>/buckets/<name>`). Exercise 1 collects the formats.
    this.adopted.importFrom(`projects/${project}/buckets/${name('adopted')}`);

    // 2. Rename between constructs: the topic used to be `orders_events`; the
    //    new code calls it `Renamed`. Keep the old construct for ONE deploy,
    //    pointing it at the new one, then delete it. cdktf drops the old
    //    resource from the JSON and emits the `moved` block.
    this.renamed = new PubsubTopic(this, 'Renamed', { name: name('events') });
    this.renamed.addMoveTarget('orders-events');
    const old = new PubsubTopic(this, 'OrdersEvents', { name: name('events') });
    old.moveTo('orders-events');

    // 3. Rename when the old construct no longer exists in code (the common
    //    case after a refactor merged without a moved block): name the old
    //    *Terraform address* directly. Without this line the plan says
    //    "google_service_account.legacy_reader will be destroyed,
    //     google_service_account.Reader will be created".
    this.reader = new ServiceAccount(this, 'Reader', { accountId: name('reader').slice(0, 30) });
    this.reader.moveFromId('google_service_account.legacy_reader');
  }
}
