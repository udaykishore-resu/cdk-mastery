import * as path from 'path';
import { AssetType, TerraformAsset, TerraformOutput } from 'cdktf';
import { Construct } from 'constructs';
import { CloudRunV2Service } from '@cdktf/provider-google/lib/cloud-run-v2-service';
import { CloudRunV2ServiceIamMember } from '@cdktf/provider-google/lib/cloud-run-v2-service-iam-member';
import { CloudSchedulerJob } from '@cdktf/provider-google/lib/cloud-scheduler-job';
import { Cloudfunctions2Function } from '@cdktf/provider-google/lib/cloudfunctions2-function';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { SecretManagerSecretIamMember } from '@cdktf/provider-google/lib/secret-manager-secret-iam-member';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { StorageBucketObject } from '@cdktf/provider-google/lib/storage-bucket-object';
import { PlatformContext, PlatformStack } from '../platform-stack';
import { DataStack } from './data-stack';
import { FoundationStack } from './foundation-stack';
import { MessagingStack } from './messaging-stack';
import { NetworkStack } from './network-stack';

export interface ComputeStackProps {
  readonly ctx: PlatformContext;
  readonly foundation: FoundationStack;
  readonly network: NetworkStack;
  readonly data: DataStack;
  readonly messaging: MessagingStack;
  /** Container image for the API. */
  readonly apiImage?: string;
}

/**
 * `m11-<env>-compute`: the Orders API on Cloud Run v2 (own SA, secret-backed
 * env, direct VPC egress to reach Cloud SQL's private IP), the worker on Cloud
 * Functions gen2 built from a TerraformAsset and triggered by the orders topic,
 * and a Cloud Scheduler job that calls the API's reconcile endpoint with an
 * OIDC token. Nothing here is public: ingress is internal + load balancer,
 * invocation needs `roles/run.invoker`.
 */
export class ComputeStack extends PlatformStack {
  readonly apiAccount: ServiceAccount;
  readonly workerAccount: ServiceAccount;
  readonly schedulerAccount: ServiceAccount;
  readonly api: CloudRunV2Service;
  readonly worker: Cloudfunctions2Function;
  readonly sourceBucket: StorageBucket;
  readonly reconcile: CloudSchedulerJob;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props.ctx);
    const { tier, region, project } = this.ctx;
    const prod = tier.name === 'prod';

    // -- identities: one per workload, least privilege ----------------------------
    this.apiAccount = new ServiceAccount(this, 'ApiAccount', { accountId: this.name('api').slice(0, 30), displayName: 'Orders API' });
    this.workerAccount = new ServiceAccount(this, 'WorkerAccount', { accountId: this.name('worker').slice(0, 30), displayName: 'Orders worker' });
    this.schedulerAccount = new ServiceAccount(this, 'SchedulerAccount', { accountId: this.name('sched').slice(0, 30), displayName: 'Orders scheduler' });

    new ProjectIamMember(this, 'ApiSqlClient', { project, role: 'roles/cloudsql.client', member: this.apiAccount.member });
    new SecretManagerSecretIamMember(this, 'ApiReadsDbPassword', {
      secretId: props.data.dbPasswordSecret.secretId, // cross-stack
      role: 'roles/secretmanager.secretAccessor',
      member: this.apiAccount.member,
    });
    new ProjectIamMember(this, 'WorkerBigqueryWriter', { project, role: 'roles/bigquery.dataEditor', member: this.workerAccount.member });
    // Eventarc delivers to the function through a push subscription that needs to invoke it.
    new ProjectIamMember(this, 'WorkerEventReceiver', { project, role: 'roles/eventarc.eventReceiver', member: this.workerAccount.member });

    // -- the API -------------------------------------------------------------------
    this.api = new CloudRunV2Service(this, 'Api', {
      name: this.name('api'),
      location: region,
      ingress: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER',
      deletionProtection: tier.retainStatefulResources,
      labels: this.labels,
      template: {
        serviceAccount: this.apiAccount.email,
        scaling: { minInstanceCount: prod ? 1 : 0, maxInstanceCount: prod ? 20 : 3 },
        maxInstanceRequestConcurrency: 80,
        timeout: '30s',
        vpcAccess: {
          egress: 'PRIVATE_RANGES_ONLY',
          networkInterfaces: [{ network: props.network.network.id, subnetwork: props.network.subnet.name }], // cross-stack
        },
        containers: [
          {
            image: props.apiImage ?? 'us-docker.pkg.dev/cloudrun/container/hello',
            ports: { containerPort: 8080 },
            resources: { limits: { cpu: '1', memory: '512Mi' }, cpuIdle: !prod, startupCpuBoost: prod },
            env: [
              { name: 'DB_HOST', value: props.data.instance.privateIpAddress },
              { name: 'DB_NAME', value: props.data.database.name },
              { name: 'DB_USER', value: props.data.dbUser.name },
              { name: 'DB_PASSWORD', valueSource: { secretKeyRef: { secret: props.data.dbPasswordSecret.secretId, version: 'latest' } } },
              { name: 'ORDERS_TOPIC', value: props.messaging.orders.id },
              { name: 'ENVIRONMENT', value: tier.name },
            ],
            startupProbe: { httpGet: { path: '/healthz', port: 8080 }, initialDelaySeconds: 2, periodSeconds: 5, failureThreshold: 6 },
            livenessProbe: { httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 30 },
          },
        ],
      },
      traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }],
    });

    // -- the worker: Cloud Functions gen2 from a TerraformAsset --------------------
    this.sourceBucket = new StorageBucket(this, 'FunctionSource', {
      name: this.name('fn-src'),
      location: region.toUpperCase(),
      uniformBucketLevelAccess: true,
      publicAccessPrevention: 'enforced',
      encryption: prod ? { defaultKmsKeyName: props.foundation.key.id } : undefined, // RequireCmekAspect in prod
      versioning: { enabled: true },
      labels: this.labels,
    });
    const source = new TerraformAsset(this, 'WorkerSource', {
      path: path.resolve(__dirname, '..', 'functions', 'worker'),
      type: AssetType.ARCHIVE,
      assetHash: this.ctx.assetHash,
    });
    const sourceObject = new StorageBucketObject(this, 'WorkerSourceObject', {
      bucket: this.sourceBucket.name,
      // Content-hashed name: a code change is a new object, which is what makes the function redeploy.
      name: `worker/${source.assetHash}.zip`,
      source: source.path,
    });

    this.worker = new Cloudfunctions2Function(this, 'Worker', {
      name: this.name('worker'),
      location: region,
      description: 'Consumes order events',
      labels: this.labels,
      buildConfig: {
        runtime: 'nodejs20',
        entryPoint: 'handleOrder',
        source: { storageSource: { bucket: this.sourceBucket.name, object: sourceObject.name } },
      },
      serviceConfig: {
        serviceAccountEmail: this.workerAccount.email,
        availableMemory: '256M',
        timeoutSeconds: 60,
        maxInstanceCount: prod ? 50 : 5,
        minInstanceCount: 0,
        ingressSettings: 'ALLOW_INTERNAL_ONLY',
        allTrafficOnLatestRevision: true,
        environmentVariables: { ANALYTICS_DATASET: props.data.dataset.datasetId, ENVIRONMENT: tier.name },
      },
      eventTrigger: {
        triggerRegion: region,
        eventType: 'google.cloud.pubsub.topic.v1.messagePublished',
        pubsubTopic: props.messaging.orders.id, // cross-stack
        retryPolicy: 'RETRY_POLICY_RETRY',
        serviceAccountEmail: this.workerAccount.email,
      },
    });

    // -- scheduler: reconcile every 15 minutes via OIDC -----------------------------
    new CloudRunV2ServiceIamMember(this, 'SchedulerInvokesApi', {
      name: this.api.name,
      location: region,
      role: 'roles/run.invoker',
      member: this.schedulerAccount.member,
    });
    this.reconcile = new CloudSchedulerJob(this, 'Reconcile', {
      name: this.name('reconcile'),
      region,
      schedule: prod ? '*/15 * * * *' : '0 * * * *',
      timeZone: 'Etc/UTC',
      attemptDeadline: '120s',
      retryConfig: { retryCount: 3, minBackoffDuration: '10s' },
      httpTarget: {
        uri: `${this.api.uri}/jobs/reconcile`,
        httpMethod: 'POST',
        oidcToken: { serviceAccountEmail: this.schedulerAccount.email, audience: this.api.uri },
      },
    });

    new TerraformOutput(this, 'ApiUri', { value: this.api.uri });
    new TerraformOutput(this, 'ApiServiceName', { value: this.api.name });
    new TerraformOutput(this, 'WorkerName', { value: this.worker.name });
  }
}
