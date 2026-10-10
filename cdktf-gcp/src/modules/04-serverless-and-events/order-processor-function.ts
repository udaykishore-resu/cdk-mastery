import * as path from 'path';
import { AssetType, TerraformAsset } from 'cdktf';
import { Construct } from 'constructs';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { StorageBucketObject } from '@cdktf/provider-google/lib/storage-bucket-object';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { Cloudfunctions2Function } from '@cdktf/provider-google/lib/cloudfunctions2-function';
import { CloudRunV2ServiceIamMember } from '@cdktf/provider-google/lib/cloud-run-v2-service-iam-member';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { SecretManagerSecretIamMember } from '@cdktf/provider-google/lib/secret-manager-secret-iam-member';
import { ITerraformDependable } from 'cdktf';
import { EnvironmentTier, mandatoryTags, resourceName } from '@cdk-mastery/shared';
import { OrderEventsTable } from './bigquery';
import { OrderTopics } from './pubsub';

export interface OrderProcessorFunctionProps {
  readonly tier: EnvironmentTier;
  readonly project: string;
  readonly region: string;
  readonly topics: OrderTopics;
  readonly table: OrderEventsTable;
  /** Secret Manager secret id (short id) the function reads as WEBHOOK_TOKEN. */
  readonly webhookSecretId: string;
  readonly dependsOn?: ITerraformDependable[];
}

/**
 * Cloud Functions gen2 = Cloud Build (source → container) + Cloud Run (the
 * service) + Eventarc (the trigger). Terraform sees one resource; the console
 * shows three products. What you upload is a zip of the source folder:
 *
 *   TerraformAsset (ARCHIVE)  zips ./functions/hello at synth into cdktf.out/stacks/<stack>/assets/…
 *   StorageBucketObject       uploads that zip; its name carries the asset hash so a source change = new object = new build
 *   Cloudfunctions2Function   buildConfig.source.storageSource points at it; eventTrigger binds the topic
 *
 * Two identities: the *runtime* SA (what the code runs as; needs BigQuery and
 * the secret) and the *trigger* SA (what Eventarc uses to invoke the function;
 * needs run.invoker on the function's Cloud Run service and eventarc.eventReceiver).
 */
export class OrderProcessorFunction extends Construct {
  readonly runtimeAccount: ServiceAccount;
  readonly triggerAccount: ServiceAccount;
  readonly sourceBucket: StorageBucket;
  readonly asset: TerraformAsset;
  readonly fn: Cloudfunctions2Function;

  constructor(scope: Construct, id: string, props: OrderProcessorFunctionProps) {
    super(scope, id);
    const tier = props.tier;
    const name = (component: string) => resourceName({ org: 'cdkm', service: 'events', env: tier.name, component });

    this.runtimeAccount = new ServiceAccount(this, 'RuntimeAccount', {
      accountId: name('fn-run'),
      displayName: 'order-processor runtime',
      dependsOn: props.dependsOn,
    });
    this.triggerAccount = new ServiceAccount(this, 'TriggerAccount', {
      accountId: name('fn-trigger'),
      displayName: 'order-processor Eventarc trigger',
      dependsOn: props.dependsOn,
    });

    this.sourceBucket = new StorageBucket(this, 'SourceBucket', {
      name: name('fn-src'),
      location: props.region,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: 'enforced',
      forceDestroy: true, // only build artefacts live here
      versioning: { enabled: false },
      lifecycleRule: [{ action: { type: 'Delete' }, condition: { age: 30 } }],
      labels: mandatoryTags(tier, 'events'),
    });

    // The asset is copied into the stack's output directory at synth; `path`
    // is relative to that directory, which is exactly where `terraform apply`
    // runs. Hash in the object name: a changed source is a new object, which
    // is a new `build_config.source` value, which triggers a rebuild.
    this.asset = new TerraformAsset(this, 'Source', {
      path: path.resolve(__dirname, 'functions', 'hello'),
      type: AssetType.ARCHIVE,
    });
    const sourceObject = new StorageBucketObject(this, 'SourceObject', {
      bucket: this.sourceBucket.name,
      name: `order-processor-${this.asset.assetHash}.zip`,
      source: this.asset.path,
    });

    this.fn = new Cloudfunctions2Function(this, 'Function', {
      name: name('order-processor'),
      location: props.region,
      description: 'Appends order events from Pub/Sub to BigQuery',
      labels: mandatoryTags(tier, 'events'),
      dependsOn: props.dependsOn,
      buildConfig: {
        runtime: 'nodejs22',
        entryPoint: 'processOrder',
        source: { storageSource: { bucket: this.sourceBucket.name, object: sourceObject.name } },
      },
      serviceConfig: {
        serviceAccountEmail: this.runtimeAccount.email,
        availableMemory: '256M',
        timeoutSeconds: 60,
        maxInstanceCount: tier.highlyAvailable ? 50 : 5,
        minInstanceCount: 0,
        // Only Eventarc/Pub/Sub (Google-internal) may reach the underlying service.
        ingressSettings: 'ALLOW_INTERNAL_ONLY',
        allTrafficOnLatestRevision: true,
        environmentVariables: {
          BQ_DATASET: props.table.dataset.datasetId,
          BQ_TABLE: props.table.table.tableId,
          // Cloud Build / Cloud Run log the deployment; keep secrets out of here.
        },
        secretEnvironmentVariables: [
          { key: 'WEBHOOK_TOKEN', projectId: props.project, secret: props.webhookSecretId, version: 'latest' },
        ],
      },
      eventTrigger: {
        triggerRegion: props.region,
        eventType: 'google.cloud.pubsub.topic.v1.messagePublished',
        pubsubTopic: props.topics.topic.id,
        // RETRY: a non-2xx (thrown error) is redelivered with backoff by the
        // Eventarc-managed subscription. DO_NOT_RETRY drops it after one try.
        retryPolicy: 'RETRY_POLICY_RETRY',
        serviceAccountEmail: this.triggerAccount.email,
      },
    });

    // Runtime identity: write rows, read one secret.
    props.table.grantWrite('FunctionWritesEvents', this.runtimeAccount.member);
    new SecretManagerSecretIamMember(this, 'ReadWebhookToken', {
      secretId: props.webhookSecretId,
      role: 'roles/secretmanager.secretAccessor',
      member: this.runtimeAccount.member,
    });

    // Trigger identity: Eventarc receives events as this SA and invokes the
    // function's Cloud Run service (same name as the function) with it.
    new ProjectIamMember(this, 'TriggerReceivesEvents', {
      project: props.project,
      role: 'roles/eventarc.eventReceiver',
      member: this.triggerAccount.member,
    });
    new CloudRunV2ServiceIamMember(this, 'TriggerInvokesFunction', {
      name: this.fn.name,
      location: props.region,
      role: 'roles/run.invoker',
      member: this.triggerAccount.member,
    });
  }
}
