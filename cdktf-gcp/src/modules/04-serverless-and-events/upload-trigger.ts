import { Construct } from 'constructs';
import { ITerraformDependable } from 'cdktf';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { CloudRunV2Service } from '@cdktf/provider-google/lib/cloud-run-v2-service';
import { CloudRunV2ServiceIamMember } from '@cdktf/provider-google/lib/cloud-run-v2-service-iam-member';
import { EventarcTrigger } from '@cdktf/provider-google/lib/eventarc-trigger';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { StorageBucketIamMember } from '@cdktf/provider-google/lib/storage-bucket-iam-member';
import { DataGoogleStorageProjectServiceAccount } from '@cdktf/provider-google/lib/data-google-storage-project-service-account';
import { EnvironmentTier, mandatoryTags, resourceName } from '@cdk-mastery/shared';

export interface UploadTriggerProps {
  readonly tier: EnvironmentTier;
  readonly project: string;
  readonly region: string;
  readonly dependsOn?: ITerraformDependable[];
}

/**
 * GCS object finalized ──Eventarc──▶ Cloud Run service.
 *
 * Eventarc offers two kinds of GCS event. *Direct* events
 * (`google.cloud.storage.object.v1.finalized`, used here) are notifications the
 * GCS service agent publishes to a Pub/Sub transport topic that Eventarc
 * creates and owns. *Audit Log* events (`google.cloud.audit.log.v1.written`)
 * need Data Access logging enabled and carry more filterable fields. Direct
 * events are cheaper and faster; they are also why the **GCS service agent
 * needs roles/pubsub.publisher** on the project — the single most common
 * reason a GCS trigger is created successfully and never fires.
 */
export class UploadTrigger extends Construct {
  readonly uploads: StorageBucket;
  readonly handlerAccount: ServiceAccount;
  readonly triggerAccount: ServiceAccount;
  readonly handler: CloudRunV2Service;
  readonly trigger: EventarcTrigger;

  constructor(scope: Construct, id: string, props: UploadTriggerProps) {
    super(scope, id);
    const tier = props.tier;
    const name = (component: string) => resourceName({ org: 'cdkm', service: 'events', env: tier.name, component });

    this.uploads = new StorageBucket(this, 'Uploads', {
      name: name('uploads'),
      location: props.region,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: 'enforced',
      forceDestroy: !tier.retainStatefulResources,
      labels: mandatoryTags(tier, 'events'),
    });

    this.handlerAccount = new ServiceAccount(this, 'HandlerAccount', { accountId: name('upload-run'), dependsOn: props.dependsOn });
    this.triggerAccount = new ServiceAccount(this, 'TriggerAccount', { accountId: name('upload-trig'), dependsOn: props.dependsOn });

    // The handler reads the object it was told about; objectViewer on this bucket only.
    new StorageBucketIamMember(this, 'HandlerReadsUploads', {
      bucket: this.uploads.name,
      role: 'roles/storage.objectViewer',
      member: this.handlerAccount.member,
    });

    this.handler = new CloudRunV2Service(this, 'Handler', {
      name: name('upload-handler'),
      location: props.region,
      ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY', // Eventarc delivery is internal
      deletionProtection: false,
      labels: mandatoryTags(tier, 'events'),
      dependsOn: props.dependsOn,
      template: {
        serviceAccount: this.handlerAccount.email,
        scaling: { minInstanceCount: 0, maxInstanceCount: tier.highlyAvailable ? 20 : 3 },
        containers: [
          {
            image: 'us-docker.pkg.dev/cloudrun/container/hello',
            ports: { containerPort: 8080 },
            resources: { limits: { cpu: '1', memory: '256Mi' }, cpuIdle: true },
          },
        ],
      },
    });

    // GCS service agent must be able to publish to Eventarc's transport topic.
    const gcsAgent = new DataGoogleStorageProjectServiceAccount(this, 'GcsAgent', { project: props.project });
    const gcsPublishes = new ProjectIamMember(this, 'GcsAgentPublishes', {
      project: props.project,
      role: 'roles/pubsub.publisher',
      member: `serviceAccount:${gcsAgent.emailAddress}`,
    });

    // Trigger identity: receive events, invoke the handler.
    new ProjectIamMember(this, 'TriggerReceivesEvents', { project: props.project, role: 'roles/eventarc.eventReceiver', member: this.triggerAccount.member });
    const invoker = new CloudRunV2ServiceIamMember(this, 'TriggerInvokesHandler', {
      name: this.handler.name,
      location: props.region,
      role: 'roles/run.invoker',
      member: this.triggerAccount.member,
    });

    this.trigger = new EventarcTrigger(this, 'Trigger', {
      name: name('on-upload'),
      location: props.region,
      serviceAccount: this.triggerAccount.email,
      // `type` is mandatory; `bucket` narrows to one bucket. Only equality
      // matching for direct events (path patterns need Audit Log events).
      matchingCriteria: [
        { attribute: 'type', value: 'google.cloud.storage.object.v1.finalized' },
        { attribute: 'bucket', value: this.uploads.name },
      ],
      destination: { cloudRunService: { service: this.handler.name, region: props.region, path: '/uploads' } },
      labels: mandatoryTags(tier, 'events'),
      // IAM propagation is eventually consistent; creating the trigger before the
      // grants exist yields a trigger that 403s its first deliveries.
      dependsOn: [gcsPublishes, invoker],
    });
  }
}
