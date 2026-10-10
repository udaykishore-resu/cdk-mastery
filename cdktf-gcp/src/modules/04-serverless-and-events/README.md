# 04 · Serverless & events

> After this module you can wire Pub/Sub (with a dead-letter queue that actually works), a Cloud Functions gen2 handler deployed from a `TerraformAsset`, an Eventarc trigger from GCS to Cloud Run, a Cloud Scheduler cron and a partitioned BigQuery sink — and you will never again apply a `google_*_iam_policy` to a resource you did not create.

## Why this exists (the problem)

Event-driven GCP is a chain of managed products, each with its own service agent and its own IAM expectations: Pub/Sub dead-letters *as its service agent*, Eventarc for GCS needs the *GCS* service agent to publish, Cloud Scheduler publishes as *its* agent, a gen2 function has a *runtime* identity and a *trigger* identity, a push subscription needs Pub/Sub to be able to *mint tokens* for the identity you name. Miss one grant and everything is created successfully, green in the console, and delivers nothing. The second problem is delivery semantics: Pub/Sub is at-least-once, which is a contract your handler must honour, not a setting you can change.

Terraform makes all of this explicit, which is the point: every grant is a line in a diff.

## Mental model

```mermaid
sequenceDiagram
  autonumber
  participant P as Producer
  participant T as orders topic
  participant E as Eventarc (managed sub)
  participant F as order-processor (Functions gen2)
  participant BQ as BigQuery order_events
  participant W as orders-worker (pull sub)
  participant D as orders-dead-letter

  P->>T: publish {orderId, amount}, attrs{type=order.created}
  T-->>E: deliver (attempt 1)
  E->>F: POST CloudEvent (as trigger SA)
  F->>BQ: insert(insertId=messageId)
  BQ-->>F: 200
  F-->>E: 2xx → ack
  T-->>W: deliver (filter: type=order.created)
  Note over W: consumer nacks / ack deadline (60s) expires
  T-->>W: redeliver with backoff 10s…600s (attempt 2..5)
  W-->>T: still failing after 5 attempts
  T->>D: forward (as Pub/Sub service agent: publisher on D, subscriber on W)
  Note over D: dead-letter-monitor sub holds it 7 days; alert (exercise 3)
```

Plus two side channels: Cloud Scheduler publishes `{type=digest}` to the same topic hourly (filtered out by the worker), and a GCS `object.finalized` event reaches a Cloud Run handler through Eventarc.

## How it works

### Pub/Sub with a working DLQ ([`pubsub.ts`](pubsub.ts))

```ts
this.subscription = new PubsubSubscription(this, 'Worker', {
  topic: this.topic.id,
  ackDeadlineSeconds: 60,
  retryPolicy: { minimumBackoff: '10s', maximumBackoff: '600s' },
  deadLetterPolicy: { deadLetterTopic: this.deadLetterTopic.id, maxDeliveryAttempts: 5 },
  filter: 'attributes.type = "order.created"',
  enableMessageOrdering: true,
  expirationPolicy: { ttl: '' },
  messageRetentionDuration: '604800s',
});
new PubsubTopicIamMember(this, 'AgentPublishesToDlq', { topic: this.deadLetterTopic.name, role: 'roles/pubsub.publisher', member: pubsubAgent });
new PubsubSubscriptionIamMember(this, 'AgentSubscribesSource', { subscription: this.subscription.name, role: 'roles/pubsub.subscriber', member: pubsubAgent });
```

| Setting | Effect | Choose by |
|---|---|---|
| `ackDeadlineSeconds` | time to ack before redelivery; pull clients auto-extend | p99 handler time; 10–600 s |
| `retryPolicy` | exponential backoff between redeliveries | without it a poison message spins at full speed |
| `deadLetterPolicy.maxDeliveryAttempts` | 5–100; then forwarded to DLQ with `CloudPubSubDeadLetterSourceDeliveryCount` and `…DeliveryErrorMessage` attributes | how many transient failures you tolerate |
| `filter` | server-side; non-matching messages are acked and dropped for this subscription | multiplexing a topic |
| `enableMessageOrdering` | in-order per ordering key; per-key throughput ~1 MB/s | when order matters per entity |
| `expirationPolicy.ttl: ''` | never auto-delete | the default (31 days idle) deletes your subscription in a quiet dev project |
| `messageRetentionDuration` + `retainAckedMessages` | `seek` back in time for replay | incident recovery |

The two IAM members are the part everyone misses: **dead-lettering is performed by the Pub/Sub service agent** (`service-<project_number>@gcp-sa-pubsub.iam.gserviceaccount.com`), which needs `publisher` on the DLQ topic and `subscriber` on the source subscription. `DataGoogleProject.number` supplies the number. `OrderTopics.grantPublish()`/`grantSubscribe()` are the additive helpers other constructs use — module 05 turns this into a reusable `PubSubPipeline`.

**At-least-once and idempotency.** Pub/Sub may deliver a message more than once (lost ack, deadline expiry, retry). `enableExactlyOnceDelivery` exists for pull subscriptions and reduces (does not eliminate) duplicates at a throughput cost. The handler in [`functions/hello/index.js`](functions/hello/index.js) does the two things that matter: it uses the `messageId` as BigQuery `insertId` (best-effort de-dup within ~1 minute) and writes a row with a business key (`order_id`) so consumers de-duplicate at query time (`QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY event_time) = 1`). Idempotency is a property of the *effect*, not of the queue.

### Cloud Functions gen2 from a `TerraformAsset` ([`order-processor-function.ts`](order-processor-function.ts))

```ts
this.asset = new TerraformAsset(this, 'Source', { path: path.resolve(__dirname, 'functions', 'hello'), type: AssetType.ARCHIVE });
const sourceObject = new StorageBucketObject(this, 'SourceObject', {
  bucket: this.sourceBucket.name, name: `order-processor-${this.asset.assetHash}.zip`, source: this.asset.path });
this.fn = new Cloudfunctions2Function(this, 'Function', {
  buildConfig: { runtime: 'nodejs22', entryPoint: 'processOrder', source: { storageSource: { bucket, object: sourceObject.name } } },
  serviceConfig: { serviceAccountEmail: runtime.email, ingressSettings: 'ALLOW_INTERNAL_ONLY', secretEnvironmentVariables: [{ key: 'WEBHOOK_TOKEN', … }] },
  eventTrigger: { eventType: 'google.cloud.pubsub.topic.v1.messagePublished', pubsubTopic: topic.id, retryPolicy: 'RETRY_POLICY_RETRY', serviceAccountEmail: trigger.email },
});
```

`TerraformAsset` with `AssetType.ARCHIVE` zips the folder **at synth** into `cdktf.out/stacks/m04-events/assets/<id>/<hash>/archive.zip` (the test proves the file exists after `fullSynth`). `asset.path` is relative to the stack directory, which is where `terraform apply` runs, so it resolves. `assetHash` is a content hash: change a line in `index.js` → new hash → new object name → new `build_config.source` → Cloud Build rebuilds. Without the hash in the name, Terraform would overwrite the object in place and the function would not notice.

A gen2 function is three products: Cloud Build (source → image in Artifact Registry), Cloud Run (the service, same name as the function), Eventarc (the trigger, which creates and owns a Pub/Sub subscription on the topic). Hence the API list in [`events-stack.ts`](events-stack.ts) and the two identities:

- **runtime SA** — what the code runs as: `bigquery.dataEditor` on the dataset (via `OrderEventsTable.grantWrite`), `secretAccessor` on one secret;
- **trigger SA** — what Eventarc invokes the function with: `eventarc.eventReceiver` on the project, `run.invoker` on the function's Cloud Run service (`CloudRunV2ServiceIamMember` with `name: fn.name`).

`retryPolicy: 'RETRY_POLICY_RETRY'` makes a thrown error (non-2xx) a nack with backoff on the Eventarc-managed subscription; `DO_NOT_RETRY` drops after one attempt. The Eventarc subscription has no DLQ of its own; add one after apply via `gcloud pubsub subscriptions update`, or route through your own subscription + push (exercise 2) when you need full control.

### Eventarc: GCS → Cloud Run ([`upload-trigger.ts`](upload-trigger.ts))

```ts
this.trigger = new EventarcTrigger(this, 'Trigger', {
  serviceAccount: this.triggerAccount.email,
  matchingCriteria: [
    { attribute: 'type', value: 'google.cloud.storage.object.v1.finalized' },
    { attribute: 'bucket', value: this.uploads.name },
  ],
  destination: { cloudRunService: { service: this.handler.name, region, path: '/uploads' } },
  dependsOn: [gcsPublishes, invoker],
});
```

Direct GCS events are notifications the **GCS service agent** publishes to a transport topic Eventarc owns, so `DataGoogleStorageProjectServiceAccount.emailAddress` gets `roles/pubsub.publisher` on the project. The trigger's SA needs `eventarc.eventReceiver` and `run.invoker` on the handler. Both grants are in `dependsOn` because IAM is eventually consistent and a trigger created a second before its grants 403s its first deliveries. `matchingCriteria` for direct events is equality only; for path patterns or `methodName` filters use Audit Log events (`google.cloud.audit.log.v1.written` with `serviceName`/`methodName`), which require Data Access audit logs on GCS.

### Cloud Scheduler → Pub/Sub ([`scheduler.ts`](scheduler.ts))

`CloudSchedulerJob` with `pubsubTarget: { topicName: topic.id, data: base64(JSON), attributes: { type: 'digest' } }`, `schedule: '0 * * * *'`, `timeZone`, `attemptDeadline` (for the publish call), `retryConfig`. Scheduler publishes as **its** service agent (`service-<number>@gcp-sa-cloudscheduler.iam.gserviceaccount.com`); `topics.grantPublish('SchedulerPublishes', agent)` makes the dependency visible and covers the cross-project case. The worker subscription's filter excludes `type=digest`, so a second consumer can subscribe for digests without the first paying for them.

### BigQuery ([`bigquery.ts`](bigquery.ts))

The table schema is a JSON string (`schema: JSON.stringify(ORDER_EVENTS_SCHEMA)`); keep the array in TypeScript, exported, so tests assert column order and the function's row shape matches. `timePartitioning` by `event_time` with `expirationMs` in dev, `clustering: ['region', 'event_type']` for the common filters, `requirePartitionFilter` in prod (prevents accidental full scans), `deletionProtection` in prod. `defaultTableExpirationMs` and `deleteContentsOnDestroy` on the dataset follow the tier.

### The IAM trap ([`iam-trap.ts`](iam-trap.ts))

Every `google_*_iam_*` family has three shapes, and the difference is not stylistic:

| Resource | Semantics | Blast radius |
|---|---|---|
| `google_pubsub_topic_iam_member` | additive: one (role, member) | that grant only |
| `google_pubsub_topic_iam_binding` | authoritative **for one role**: the `members` list replaces whoever has the role | every other holder of that role, wherever it was granted |
| `google_pubsub_topic_iam_policy` | authoritative **for everything**: replaces the entire policy | every role and member on the resource, including Google service agents |

The lock-out story (it happens every year somewhere): a team manages `roles/owner` on a project with an `_iam_binding`. During an incident someone adds the on-call engineer as owner in the console. The next `terraform apply` shows `- members: user:oncall@…` and gets approved as "restoring desired state" — mid-incident. The worse variant: a `google_project_iam_policy` written for a fresh project is applied to an existing one; it lists no owner for the deployer and no service agents; the API accepts it; the deployer's next call is a 403 and only an org admin can restore access. In this module's world, an `_iam_policy` on the DLQ topic would remove the Pub/Sub agent's `publisher` grant and silently break dead-lettering.

Rules: `_iam_member` by default; `_iam_binding` only for a role you own end to end (never `roles/owner`); `_iam_policy` only on a resource your stack created and nothing else will touch. `IamTrapStack` renders all three for the tests; `EventsStack` uses only `_iam_member` (the test checks).

## Walkthrough

1. [`functions/hello/index.js`](functions/hello/index.js), [`package.json`](functions/hello/package.json) — the handler: decode, `insertId`, throw on failure.
2. [`pubsub.ts`](pubsub.ts) — `OrderTopics`: topic, DLQ, worker sub, monitor sub, agent grants, `grantPublish`/`grantSubscribe`.
3. [`bigquery.ts`](bigquery.ts) — `OrderEventsTable`, `ORDER_EVENTS_SCHEMA`, `grantWrite`.
4. [`order-processor-function.ts`](order-processor-function.ts) — asset → object → function, two SAs, IAM.
5. [`upload-trigger.ts`](upload-trigger.ts) — bucket, handler service, Eventarc trigger, agent grant.
6. [`scheduler.ts`](scheduler.ts) — `DigestSchedule`.
7. [`iam-trap.ts`](iam-trap.ts) — the three IAM shapes (test-only stack).
8. [`events-stack.ts`](events-stack.ts) — APIs, project number, secret, composition. [`index.ts`](index.ts) registers `m04-events`.
9. [`../../../test/04-serverless-and-events.test.ts`](../../../test/04-serverless-and-events.test.ts).

```
npx jest test/04-serverless-and-events.test.ts
bash ../scripts/typecheck-module.sh cdktf-gcp 04-serverless-and-events
npx cdktf deploy m04-events
gcloud pubsub topics publish cdkm-events-dev-orders --message='{"orderId":"o-1","amount":12.5}' --attribute=type=order.created
```

## Production notes

- **DLQ monitoring is not optional.** A DLQ nobody alerts on is data loss with extra steps. Exercise 3 alerts on `subscription/dead_letter_message_count` (reported on the *source* subscription) and on the DLQ backlog. Runbook: pull with `gcloud pubsub subscriptions pull … --format=json`, read `CloudPubSubDeadLetterSourceDeliveryErrorMessage`, fix, republish to the source topic, ack.
- **Backlog and age.** `subscription/oldest_unacked_message_age` > your SLO is the consumer-is-down alarm; `num_undelivered_messages` growing is the consumer-too-slow alarm. Both are free metrics.
- **Cost.** Pub/Sub bills per TiB of throughput after 10 GiB free; retention of acked messages bills storage. Functions gen2 bill like Cloud Run (per vCPU-second, per request, min instances continuous) plus Cloud Build minutes per deploy and Artifact Registry storage for images. BigQuery streaming inserts bill per GiB inserted (~$0.05/GiB via the legacy streaming API the client uses here; the Storage Write API is cheaper) and partition expiry keeps storage bounded. Eventarc and Scheduler are pennies. The line item people forget: **Cloud Logging ingestion** from chatty functions — set a log exclusion for `severity<WARNING` in dev.
- **Ordering keys throttle.** With `enableMessageOrdering`, throughput per ordering key is limited (~1 MB/s) and a failing message blocks its key. Use the narrowest key that satisfies the ordering requirement (order id, not tenant id).
- **Secrets.** `secretEnvironmentVariables` with `version: 'latest'` resolves at instance start; rotating the secret requires a new revision to pick it up. Pin a version in prod and deploy to rotate.
- **Gen2 cold starts.** `minInstanceCount: 0` in dev; consider 1 in prod for latency-sensitive handlers (billed continuously).

## Gotchas

- Symptom: messages redeliver forever, never reach the DLQ; console shows a yellow permission banner on the subscription → cause: Pub/Sub service agent lacks `publisher` on the DLQ topic or `subscriber` on the source → fix: the two `_iam_member`s in `OrderTopics`.
- Symptom: GCS trigger created, uploads happen, handler never called → cause: GCS service agent lacks `roles/pubsub.publisher` → fix: `DataGoogleStorageProjectServiceAccount` + `ProjectIamMember` (in `UploadTrigger`).
- Symptom: function deploy fails with "Build failed… permission denied" → cause: Cloud Build's default SA changed in 2024 (new projects use the Compute default SA, which may lack `roles/cloudbuild.builds.builder`/Artifact Registry writer) → fix: set `buildConfig.serviceAccount` to a dedicated SA with `cloudbuild.builds.builder`, `artifactregistry.writer`, `logging.logWriter`, `storage.objectViewer` on the source bucket.
- Symptom: function invocations 403 → cause: trigger SA lacks `run.invoker` on the function's Cloud Run service (`ALLOW_INTERNAL_ONLY` is ingress, not IAM) → fix: `CloudRunV2ServiceIamMember` with `name: fn.name`.
- Symptom: `cdktf deploy` uploads a new zip on every run although nothing changed → cause: a file in the asset folder changes per build (`node_modules`, a timestamped file) → fix: keep the asset folder to source only; `.gcloudignore` does not apply to `TerraformAsset`.
- Symptom: subscription vanished after a month of no traffic → cause: default `expirationPolicy` (31 days idle) → fix: `expirationPolicy: { ttl: '' }`.
- Symptom: `terraform destroy` of the dataset fails "still contains tables" → cause: `deleteContentsOnDestroy` false → fix: tier-driven (as here); in prod that failure is the point.
- Symptom: after an `_iam_binding` apply, a colleague lost a role they had for years → cause: binding is authoritative for that role → fix: convert to `_iam_member`s; `terraform state rm` the binding first so removing it from code does not remove the grants.

## Exercises

1. **BigQuery subscription.** Add a second subscription on the orders topic that writes straight into `order_events` (`bigqueryConfig`, `useTableSchema`, `dropUnknownFields`), sharing the DLQ, after granting the Pub/Sub service agent `bigquery.dataEditor` on the dataset. Solution: [`solutions/01-bigquery-subscription.ts`](solutions/01-bigquery-subscription.ts).
2. **Push with OIDC.** A push subscription to the private upload handler: a push SA with `run.invoker`, the Pub/Sub agent with `iam.serviceAccountTokenCreator` on that SA, `oidcToken` with a pinned `audience`. Solution: [`solutions/02-push-subscription.ts`](solutions/02-push-subscription.ts).
3. **DLQ alert.** A `MonitoringAlertPolicy` with two conditions — `dead_letter_message_count` on the worker subscription and `num_undelivered_messages` on the monitor subscription — an email channel, severity by tier, and runbook documentation in the policy. Solution: [`solutions/03-dlq-alert.ts`](solutions/03-dlq-alert.ts).

## Checklist

- [ ] Every subscription with a DLQ also grants the Pub/Sub agent `publisher` on the DLQ and `subscriber` on itself.
- [ ] Every subscription sets `expirationPolicy.ttl: ''`, a `retryPolicy`, and an `ackDeadlineSeconds` justified by handler latency.
- [ ] DLQ alerts exist and page someone; the runbook is in the alert documentation.
- [ ] Handlers are idempotent on a business key; `insertId`/message id is used where the sink supports it.
- [ ] Functions and services run as dedicated SAs; trigger identities are separate from runtime identities.
- [ ] Assets contain source only; the object name carries the asset hash.
- [ ] Code review: no `_iam_binding`/`_iam_policy` outside resources the stack creates; never on projects/folders/orgs.
- [ ] Code review: BigQuery tables are partitioned and clustered; prod has `requirePartitionFilter` and `deletionProtection`.

## Interview angle

1. *"Pub/Sub says at-least-once. What does your handler have to do about it?"* — Assume duplicates and out-of-order delivery (unless ordering keys): make the effect idempotent (upsert on a business key, `insertId` for BigQuery streaming, conditional writes elsewhere), bound retries with a DLQ, and alert on the DLQ. Exactly-once delivery on pull reduces duplicates at a cost but does not remove the need.
2. *"Why does a dead-letter policy need IAM, and for whom?"* — Forwarding is done by the Pub/Sub service agent, not the subscriber; it needs to publish to the DLQ and to pull/ack from the source. Missing grants fail silently: redeliveries continue up to retention, then messages are dropped.
3. *"Explain `_iam_member` vs `_iam_binding` vs `_iam_policy` and when each is acceptable."* — Additive vs authoritative-per-role vs authoritative-for-all. Member by default; binding only for roles fully owned by the stack (never owner); policy only on stack-created leaf resources. The failure mode is silent removal of grants made elsewhere, including Google service agents, up to locking the deployer out.

## References

- Pub/Sub dead-letter topics: https://cloud.google.com/pubsub/docs/handling-failures
- Pub/Sub subscription properties (ack deadline, retry, filter, ordering): https://cloud.google.com/pubsub/docs/subscription-properties
- Exactly-once delivery: https://cloud.google.com/pubsub/docs/exactly-once-delivery
- Cloud Functions gen2 with Terraform: https://cloud.google.com/functions/docs/tutorials/terraform-pubsub
- Eventarc Cloud Storage triggers: https://cloud.google.com/eventarc/docs/run/create-trigger-storage-gcloud
- Eventarc IAM roles: https://cloud.google.com/eventarc/docs/access-control
- Cloud Scheduler Pub/Sub target: https://cloud.google.com/scheduler/docs/tut-pub-sub
- BigQuery partitioned tables: https://cloud.google.com/bigquery/docs/partitioned-tables
- Pub/Sub BigQuery subscriptions: https://cloud.google.com/pubsub/docs/bigquery
- Push subscriptions with authentication: https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions
- Pub/Sub metrics: https://cloud.google.com/pubsub/docs/monitoring
- Google provider IAM resource families: https://registry.terraform.io/providers/hashicorp/google/6.50.0/docs/resources/pubsub_topic_iam
- CDKTF assets: https://developer.hashicorp.com/terraform/cdktf/concepts/assets
