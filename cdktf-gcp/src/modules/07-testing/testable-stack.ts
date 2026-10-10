import * as path from 'path';
import { AssetType, GcsBackend, TerraformAsset, TerraformOutput, TerraformStack, TerraformVariable } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { DataGoogleProject } from '@cdktf/provider-google/lib/data-google-project';
import { PubsubSubscription } from '@cdktf/provider-google/lib/pubsub-subscription';
import { PubsubTopic } from '@cdktf/provider-google/lib/pubsub-topic';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { StorageBucketObject } from '@cdktf/provider-google/lib/storage-bucket-object';
import { EnvironmentTier, environmentFor, mandatoryTags, resourceName } from '@cdk-mastery/shared';
import { gcpProject, gcpRegion } from './gcp-config';
import { PrivateBucket } from './private-bucket';

export interface TestableStackProps {
  readonly tier: string;
  readonly project?: string;
  readonly region?: string;
  /** When set, state goes to this GCS bucket; otherwise the backend is local (offline synth). */
  readonly stateBucket?: string;
  /**
   * Pin the asset hash. Content hashes change whenever `assets/config` changes,
   * which is correct for deploys and noise for snapshots; see README.
   */
  readonly assetHash?: string;
}

/**
 * A stack built to be tested: one of everything the matchers and hand
 * assertions need to cover.
 *
 *   provider           GoogleProvider
 *   data source        DataGoogleProject
 *   variable           MaxDeliveryAttempts (with default)
 *   resources          bucket (via PrivateBucket), object from a TerraformAsset,
 *                      service account, topic, dead-letter topic, subscription
 *   meta-arguments     dependsOn (subscription -> SA), lifecycle (topic)
 *   outputs            two, one sensitive
 *   backend            gcs when props.stateBucket is set, local otherwise
 */
export class TestableStack extends TerraformStack {
  readonly tier: EnvironmentTier;
  readonly bucket: PrivateBucket;
  readonly topic: PubsubTopic;
  readonly deadLetter: PubsubTopic;
  readonly subscription: PubsubSubscription;
  readonly worker: ServiceAccount;

  constructor(scope: Construct, id: string, props: TestableStackProps) {
    super(scope, id);
    this.tier = environmentFor(props.tier);
    const project = props.project ?? gcpProject();
    const region = props.region ?? gcpRegion();
    const name = (component: string) => resourceName({ org: 'cdkm', service: 'testable', env: this.tier.name, component });
    const labels = mandatoryTags(this.tier, 'testable');

    new GoogleProvider(this, 'Google', { project, region });
    if (props.stateBucket) {
      new GcsBackend(this, { bucket: props.stateBucket, prefix: `cdk-mastery/${id}` });
    }

    const current = new DataGoogleProject(this, 'Current', { projectId: project });

    const maxDeliveryAttempts = new TerraformVariable(this, 'MaxDeliveryAttempts', {
      type: 'number',
      default: 5,
      description: 'Deliveries before a message is dead-lettered',
    });
    maxDeliveryAttempts.overrideLogicalId('max_delivery_attempts');

    this.worker = new ServiceAccount(this, 'Worker', {
      accountId: name('worker').slice(0, 30),
      displayName: 'Testable worker',
    });

    this.bucket = new PrivateBucket(this, 'Artifacts', {
      name: name('artifacts'),
      location: region.toUpperCase(),
      readers: [this.worker.member],
      labels,
    });

    // An asset: copied into the stack's output dir at synth, referenced by a
    // content-hashed path. Absolute source path so it works without cdktf.json.
    const config = new TerraformAsset(this, 'ConfigAsset', {
      path: path.resolve(__dirname, 'assets', 'config'),
      type: AssetType.ARCHIVE,
      assetHash: props.assetHash,
    });
    new StorageBucketObject(this, 'ConfigObject', {
      bucket: this.bucket.bucket.name,
      name: `config/${config.fileName}`,
      source: config.path,
    });

    this.deadLetter = new PubsubTopic(this, 'DeadLetter', { name: name('dlq'), labels });
    this.topic = new PubsubTopic(this, 'Orders', {
      name: name('orders'),
      labels,
      messageRetentionDuration: this.tier.highlyAvailable ? '604800s' : '86400s',
      // Labels are frequently mutated by cost tooling; do not fight it.
      lifecycle: { ignoreChanges: ['labels'] },
    });
    this.subscription = new PubsubSubscription(this, 'OrdersSub', {
      name: name('orders-sub'),
      topic: this.topic.name,
      ackDeadlineSeconds: 30,
      deadLetterPolicy: { deadLetterTopic: this.deadLetter.id, maxDeliveryAttempts: maxDeliveryAttempts.numberValue },
      labels,
      // The Pub/Sub service agent needs publish rights on the DLQ before the
      // subscription is created or the API rejects the dead-letter policy; in a
      // real stack that is an IAM member, here the SA stands in to show the shape.
      dependsOn: [this.worker],
    });

    new TerraformOutput(this, 'TopicName', { value: this.topic.name });
    new TerraformOutput(this, 'ProjectNumber', { value: current.number, sensitive: true });
  }
}
