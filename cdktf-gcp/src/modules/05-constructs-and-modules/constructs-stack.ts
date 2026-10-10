import { TerraformOutput, TerraformStack, Token } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { DataGoogleProject } from '@cdktf/provider-google/lib/data-google-project';
import { KmsKeyRing } from '@cdktf/provider-google/lib/kms-key-ring';
import { KmsCryptoKey } from '@cdktf/provider-google/lib/kms-crypto-key';
import { environmentFor, resourceName } from '@cdk-mastery/shared';
import { gcpProject, gcpRegion } from './gcp-config';
import { PubSubPipeline } from './pubsub-pipeline';
import { RegistryNetwork } from './registry-network';
import { SecureBucket } from './secure-bucket';
import { ServiceAccountWithRoles } from './service-account-with-roles';

export interface ConstructsStackProps {
  readonly tier: string;
  readonly project?: string;
  readonly region?: string;
  /** Encrypt the data bucket with a CMEK created in this stack. */
  readonly cmek?: boolean;
}

/**
 * The constructs in use. Read this as the *consumer's* view: no IAM resource
 * types, no service-agent principals, no lifecycle rule syntax — just intent.
 */
export class ConstructsStack extends TerraformStack {
  readonly logs: SecureBucket;
  readonly data: SecureBucket;
  readonly pipeline: PubSubPipeline;
  readonly worker: ServiceAccountWithRoles;
  readonly network: RegistryNetwork;

  constructor(scope: Construct, id: string, props: ConstructsStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    const project = props.project ?? gcpProject();
    const region = props.region ?? gcpRegion();
    new GoogleProvider(this, 'Google', { project, region });
    const projectNumber = Token.asString(new DataGoogleProject(this, 'Project').number);
    const name = (component: string) => resourceName({ org: 'cdkm', service: 'lib', env: tier.name, component });

    let key: KmsCryptoKey | undefined;
    if (props.cmek) {
      // Key rings are immutable and undeletable; name them for the region and purpose.
      const ring = new KmsKeyRing(this, 'KeyRing', { name: name(`ring-${region}`), location: region });
      key = new KmsCryptoKey(this, 'BucketKey', {
        name: name('bucket-key'),
        keyRing: ring.id,
        rotationPeriod: '7776000s', // 90 days
        // Do not destroy the key with the stack: encrypted data would be unreadable.
        lifecycle: { preventDestroy: tier.retainStatefulResources },
      });
    }

    this.logs = new SecureBucket(this, 'Logs', { tier, name: name('access-logs'), location: region, service: 'lib', noncurrentVersionRetentionDays: 30 });
    this.data = new SecureBucket(this, 'Data', {
      tier,
      name: name('data'),
      location: region,
      service: 'lib',
      project,
      encryptionKey: key,
      accessLogsBucket: this.logs,
      lifecycleRules: [{ action: { type: 'SetStorageClass', storageClass: 'NEARLINE' }, condition: { age: 30, withState: 'LIVE' } }],
    });

    this.pipeline = new PubSubPipeline(this, 'Events', { tier, name: name('events'), projectNumber, maxDeliveryAttempts: 7 });

    this.worker = new ServiceAccountWithRoles(this, 'Worker', {
      accountId: name('worker'),
      project,
      roles: ['roles/logging.logWriter', 'roles/monitoring.metricWriter'],
    });
    // Intent, not IAM syntax:
    this.pipeline.grantSubscribe(this.worker.member, 'WorkerSubscribes');
    this.data.grantWrite('WorkerWrites', this.worker.member);
    this.logs.grantRead('WorkerReadsLogs', this.worker.member);

    this.network = new RegistryNetwork(this, 'Network', {
      project,
      networkName: name('vpc'),
      subnets: [{ name: name(`workloads-${region}`), cidr: '10.30.0.0/24', region, secondaryRanges: { pods: '10.32.0.0/14' } }],
    });

    new TerraformOutput(this, 'data_bucket', { value: this.data.bucketUrl });
    new TerraformOutput(this, 'events_topic', { value: this.pipeline.topic.id });
    new TerraformOutput(this, 'worker_email', { value: this.worker.email });
    new TerraformOutput(this, 'network_name', { value: this.network.networkName });
    new TerraformOutput(this, 'subnet_ids', { value: this.network.subnetIds });
  }
}
