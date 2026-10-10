# 04 · Serverless & event-driven

> After this module you can wire HTTP API → Lambda → DynamoDB, EventBridge → SQS → worker, and a Step Functions saga with compensation — each with least-privilege `grant*` calls, owned log groups, esbuild-bundled TypeScript, and a canary-deployed Lambda alias — and you can explain every IAM statement CDK wrote for you.

## Why this exists (the problem)

Serverless architectures are mostly glue: permissions, retries, dead-letter queues, batch semantics, log retention, and traffic shifting. Each of those is small, boring and easy to get wrong, and getting one wrong looks like an outage weeks later (a DLQ filling silently, a log group with infinite retention and a five-figure bill, a bad deploy that hit 100% of traffic). Hand-written CloudFormation for this is hundreds of lines per service and never consistent across teams.

CDK's L2s encode the glue as methods: `table.grantReadWriteData(fn)` is one line and produces exactly the right statement; `SqsEventSource` knows which four SQS actions a poller needs; `LambdaDeploymentGroup` wires CodeDeploy, the alias and the rollback alarm. The job is to know which of those methods exist, what they produce, and where the defaults are still wrong for production.

## Mental model

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant API as HTTP API ($default stage)
  participant A as Alias "live" (CodeDeploy-shifted)
  participant F as api.ts (NodejsFunction)
  participant T as TableV2 Orders (+gsi1)
  participant B as EventBus cdk-mastery-dev-orders
  participant Q as SQS OrderEvents (DLQ after 3)
  participant W as worker.ts
  participant S as Step Functions OrderSaga
  participant P as saga.ts
  participant SCH as EventBridge Scheduler
  participant R as scheduled.ts

  C->>API: POST /orders {customerId,total}
  API->>A: invoke (payload v2, routeKey)
  A->>F: version N (10%) or N-1 (90%) during canary
  F->>T: PutItem ORDER#id / META (grantReadWriteData)
  F-->>C: 201 order
  Note over B: something publishes OrderPlaced (exercise 3 does it from a Map state)
  B->>Q: Rule OrderPlaced (source, detail-type, total>0) → SendMessage
  Q->>W: batch ≤10, window 5s, maxConcurrency 2
  W->>T: UpdateItem status placed→processed (grantWriteData, conditional)
  W-->>Q: {batchItemFailures:[ids]} — only those return; DLQ after 3 receives
  C->>S: StartExecution {orderId,total}
  S->>P: Reserve (retry ServiceUnavailable ×3)
  S->>P: Charge (retry; catch PaymentDeclined → Release)
  alt charged
    S->>T: DynamoPutItem ORDER#id / SAGA (optimised integration, no Lambda)
  else declined
    S->>P: Release (compensation) → Fail
  end
  SCH->>R: 02:00 Europe/London, flexible window 15 min, retry 2, DLQ
```

Three independent paths — synchronous request, asynchronous event, orchestrated workflow — share one table and one set of rules: every principal gets exactly the actions it needs; every asynchronous hop has a retry policy and a dead-letter destination; every function has an owned log group.

## How it works

### HTTP API → Lambda → DynamoDB (`api-stack.ts`, `handlers/api.ts`)

**Table.** `dynamodb.TableV2` renders `AWS::DynamoDB::GlobalTable` even for a single region — that is the resource type that models on-demand billing, replicas and per-index settings cleanly. Single-table layout: `pk = ORDER#<id>`, `sk = META`; `gsi1` on `(gsi1pk = CUSTOMER#<id>, gsi1sk = placedAt)` serves "a customer's orders, newest first". `timeToLiveAttribute`, PITR and `RemovalPolicy` follow the tier.

**Function.** `NodejsFunction` with `entry: handlers/api.ts` runs esbuild at synth time — locally, because esbuild is installed in the repo (no Docker). `bundlingFor(tier)` sets `minify`, `sourceMap: false`, `target: 'node22'`, CJS. `@aws-sdk/*` is external by default for a pinned runtime, so the bundle is one small `index.js` that `require`s the SDK the runtime provides (the test opens the asset and checks). The repo does not install `@aws-sdk/*` or `@types/aws-lambda`; `handlers/aws-sdk-shim.d.ts` declares the handful of types the handlers use so they type-check here — delete it and `npm i -D` the real packages in a real service.

`logGroup` is passed explicitly with tier retention. Without it, the runtime creates `/aws/lambda/<name>` with **infinite retention** on first invocation, or — with `@aws-cdk/aws-lambda:useCdkManagedLogGroup` from `cdk.json` — CDK creates one with no retention. Neither is what you want. The old `logRetention` prop creates a `Custom::LogRetention` resource; the test asserts there is none.

**Least privilege.** `this.table.grantReadWriteData(this.handler)` produces a statement with `dynamodb:BatchGetItem, Query, GetItem, Scan, ConditionCheckItem, BatchWriteItem, PutItem, UpdateItem, DeleteItem, DescribeTable` on the table ARN and `<arn>/index/*` (plus, a `TableV2` quirk, a second statement with `GetRecords`/`GetShardIterator` on the same ARNs even without a stream). No `dynamodb:*`, no `DeleteTable`. Exercise 1 splits reads to a second function with `grantReadData` so the read path physically cannot write.

**Alias + canary.** `this.handler.currentVersion` publishes an `AWS::Lambda::Version` whose logical ID embeds the code hash (a code change is a new Version; old ones are `RETAIN`ed). `lambda.Alias 'live'` points at it. `codedeploy.LambdaDeploymentGroup({ alias, deploymentConfig, alarms, autoRollback })` makes CloudFormation hand the alias update to CodeDeploy, which shifts traffic per the config — `CANARY_10PERCENT_5MINUTES` in tiers that require approval, `ALL_AT_ONCE` in dev — and rolls back if the `Errors` alarm on the *alias* (dimension `Resource = <fn>:live`) fires. The HTTP integration and the invoke permission target the alias, never the function, so callers are unaffected by the shift.

**HTTP API.** `apigwv2.HttpApi` with `createDefaultStage: false` and an explicit `HttpStage` named `$default` — the implicit stage has no throttling and no access logs. `throttle`, `detailedMetricsEnabled`, `accessLogSettings` (JSON with standard fields into an owned log group) and `corsPreflight` are all set. One `HttpLambdaIntegration` (payload format 2.0, which gives the handler `routeKey`) is shared by three `addRoutes` calls.

### EventBridge → SQS → worker (`events-stack.ts`, `handlers/worker.ts`)

A custom `EventBus` per domain; a `Rule` with a content pattern (`source`, `detail-type`, `detail.total > 0`) and a `targets.SqsQueue` with its own EventBridge-side `deadLetterQueue`, `retryAttempts: 3`, `maxEventAge: 1h`. `targets.SqsQueue` writes the queue policy that lets `events.amazonaws.com` send, scoped to the rule ARN (`@aws-cdk/aws-events:eventsTargetQueueSameAccount`).

The queue: `visibilityTimeout = 6 × function timeout` (Lambda's documented minimum), `deadLetterQueue: { queue, maxReceiveCount: 3 }`, SSE-SQS, 4-day retention; the DLQ keeps 14 days. `SqsEventSource` on the worker: `batchSize: 10`, `maxBatchingWindow: 5s`, `reportBatchItemFailures: true`, `maxConcurrency` (mapping-level, distinct from `reservedConcurrentExecutions`). The event source grants the four SQS actions a poller needs; `props.table.grantWriteData(this.worker)` grants writes only (the test asserts no `GetItem`/`Query`).

`worker.ts` catches per record and returns `{ batchItemFailures }` — the contract behind `reportBatchItemFailures`. Without it, one poison message fails the whole batch and every good message is retried too. The update is conditional (`placed → processed`) so redeliveries are no-ops.

Two alarms every queue consumer needs: DLQ `ApproximateNumberOfMessagesVisible > 0` and queue `ApproximateAgeOfOldestMessage > 10 min` (the consumer is behind or dead).

### The modern cron: EventBridge Scheduler (`events-stack.ts`, `handlers/scheduled.ts`)

`scheduler.Schedule` with `ScheduleExpression.cron({ minute: '0', hour: '2', timeZone: TimeZone.EUROPE_LONDON })`, `TimeWindow.flexible(15 min)`, and a `schedulerTargets.LambdaInvoke` carrying `input`, `retryAttempts`, `maxEventAge` and a `deadLetterQueue`. Versus a scheduled `events.Rule`: time zones and DST, one-off `at()` schedules, start/end dates, flexible windows, schedule groups for bulk enable/disable, and per-target retry/DLQ without a rule in between. The role is created for `scheduler.amazonaws.com` with `lambda:InvokeFunction` on the target only. The test asserts the stack contains exactly one `AWS::Events::Rule` — the cron is not one.

### The saga (`saga-stack.ts`, `handlers/saga.ts`)

`tasks.LambdaInvoke` ×3 (`payloadResponseOnly: true` so the task's `Resource` is the function ARN and its `Parameters` are the payload; `resultPath: '$.<step>'` so each result lands under its own key), each with `addRetry({ errors: ['ServiceUnavailable'], interval 2s, maxAttempts 3, backoffRate 2 })` and `retryOnServiceExceptions` for `Lambda.ServiceException` & co. `charge.addCatch(release, { errors: ['PaymentDeclined'], resultPath: '$.error' })` is the compensation edge; a `Choice` on `$.charge.ok` covers the "returned false instead of throwing" case. `tasks.DynamoPutItem` writes `ORDER#<id> / SAGA` with `JsonPath.format` — an optimised service integration (`arn:…:states:::dynamodb:putItem`), no Lambda in the loop. The state machine is `STANDARD` (exactly-once transitions, up to a year), `tracingEnabled`, error-level logs without execution data (payloads may carry PII). Its role gets `lambda:InvokeFunction` on `steps` and `dynamodb:PutItem` on the table — the test asserts those are the only DynamoDB actions.

`DefinitionBody.fromChainable(definition)` renders JSONPath ASL. Step Functions also supports JSONata (`queryLanguage: sfn.QueryLanguage.JSONATA`); the JSONPath form is used here because it is what most existing definitions and docs use.

## Walkthrough

From `aws-cdk/`:

1. `handlers/types.ts` then `handlers/api.ts` — the data model and the handler. Note the client outside the handler and the conditional put.
2. `api-stack.ts` — read top to bottom; run `npx cdk synth M04-Api --quiet && ls cdk.out | grep asset` to see the bundled asset, and `cat cdk.out/asset.*/index.js | head -c 300`.
3. `handlers/worker.ts` then `events-stack.ts` — trace one message from the rule to `batchItemFailures`.
4. `handlers/saga.ts` then `saga-stack.ts` — `npx cdk synth M04-Saga | grep -A2 '"Retry"'`.
5. `handlers/scheduled.ts` and the Scheduler block at the end of `events-stack.ts`.
6. `test/04-serverless-and-events.test.ts` — `npx jest test/04-serverless-and-events.test.ts` (≈40 s; three esbuild bundles). The handler tests mock `@aws-sdk/lib-dynamodb` with `jest.mock(..., { virtual: true })` because the package is not installed.

All three stacks are env-agnostic; `M04-Events` and `M04-Saga` receive `api.table` and therefore depend on `M04-Api` (weak references under `cdk.json`).

## Production notes

- **Canary configs cost time.** `CANARY_10PERCENT_5MINUTES` adds five minutes to every deploy; `LINEAR_10PERCENT_EVERY_1MINUTE` adds ten. Pair with alarms that actually fire within the window (`Errors`, `Duration` p99, a business metric) and `TreatMissingData.NOT_BREACHING` so a quiet service does not roll back.
- **`currentVersion` + `RETAIN`** accumulates versions; a `lambda.Version` count near 75 per function needs a cleanup routine (or `removalPolicy: DESTROY` on `currentVersionOptions` once you trust rollbacks via CodeDeploy).
- **Reserved concurrency** on the worker protects DynamoDB and the account pool but is subtracted from the account's unreserved pool; in accounts with many functions, prefer mapping-level `maxConcurrency` and leave reserved unset.
- **Visibility timeout vs batching window vs timeout.** `visibilityTimeout ≥ 6 × timeout`; `maxBatchingWindow` adds latency but cuts invocations; a long `timeout` with a small batch wastes money. Revisit when the handler changes.
- **DLQ is not a strategy; redrive is.** Alarm on DLQ depth, keep 14-day retention, and have a runbook (`aws sqs start-message-move-task`) for redriving after the fix.
- **HTTP API vs REST API.** HTTP API is cheaper and simpler; use REST API when you need request validation models, usage plans/API keys, WAF, or private endpoints.
- **Express vs Standard** (exercise 3): Express for high-volume short idempotent work billed by duration; Standard for anything that needs exactly-once transitions or runs longer than five minutes.
- **Monitor:** Lambda `Errors`, `Throttles`, `Duration` p99, `IteratorAge`-equivalent for SQS (`ApproximateAgeOfOldestMessage`), DLQ depth, API 5xx and integration latency, Step Functions `ExecutionsFailed`/`ExecutionThrottled`, Scheduler `InvocationDroppedCount`.

## Gotchas

- Symptom: worker retries good messages after one bad one → cause: no `reportBatchItemFailures`, or the handler throws instead of returning failures → fix: enable it and return `{ batchItemFailures }`.
- Symptom: duplicates processed when the function runs long → cause: `visibilityTimeout < 6 × timeout` → fix: the ratio, or lower the timeout.
- Symptom: `Custom::LogRetention` resources and a Lambda called `LogRetention…` in the template → cause: `logRetention` prop → fix: `logGroup: new logs.LogGroup(...)`.
- Symptom: log groups exist with never-expire retention despite the CDK flag → cause: `useCdkManagedLogGroup` creates the group but sets no retention → fix: own the log group.
- Symptom: CodeDeploy deployment stuck or rolled back on first deploy → cause: alarm in `INSUFFICIENT_DATA` with `treatMissingData: MISSING/BREACHING` → fix: `NOT_BREACHING`.
- Symptom: `esbuild cannot run locally. Switching to Docker bundling` → cause: esbuild not resolvable from the project root, or major version mismatch → fix: install it at the workspace root (it is here) and keep it on the 0.x line the lib expects.
- Symptom: handler `Cannot find module '@aws-sdk/lib-dynamodb'` in unit tests → cause: the SDK is external and not installed → fix: `jest.mock(..., { virtual: true })` as in the test, or install the SDK as a dev dependency.
- Symptom: `HttpApi` stage has no throttling → cause: the implicit `$default` stage → fix: `createDefaultStage: false` + explicit `HttpStage` with `throttle`.
- Symptom: Scheduler invokes at the wrong hour after DST → cause: `events.Rule` cron is UTC-only → fix: `aws-scheduler` with `timeZone`.
- Symptom: `MaximumBatchingWindowInSeconds` rejected → cause: FIFO queue → fix: omit it (exercise 2).
- Symptom: Step Functions `States.Runtime` on `$.charge.ok` → cause: `resultPath` not set, so the result replaced the state → fix: `resultPath: '$.charge'`.

## Exercises

1. **Read/write split.** Add a second function with `grantReadData` serving the two GET routes under `/read/...` and prove its policy contains no write actions. Solution: `solutions/exercise-1-read-only-handler.ts`.
2. **FIFO pipeline.** Rebuild rule → queue → worker with FIFO queues (content-based dedup, high-throughput mode), a `messageGroupId` on the rule target, and an event source without a batching window. Solution: `solutions/exercise-2-fifo-pipeline.ts`.
3. **Bulk import as an Express workflow.** A `Map` over `$.orders` with `maxConcurrency`, a `Pass` to normalise, and `EventBridgePutEvents` publishing `OrderPlaced` to the bus — closing the loop with the worker. Solution: `solutions/exercise-3-bulk-import-express.ts`.

## Checklist

- [ ] Every function has an owned `LogGroup` with retention; no `logRetention`, no runtime-created groups.
- [ ] Every principal is granted with `grant*`; no `iam.PolicyStatement` with `*` actions in this module.
- [ ] Every asynchronous hop (rule target, queue, scheduler target) has a retry policy and a DLQ, and the DLQ has an alarm.
- [ ] SQS consumers use `reportBatchItemFailures` and are idempotent.
- [ ] Traffic-shifting deploys for user-facing functions, with an alias-scoped alarm and `autoRollback`.
- [ ] HTTP API stage has throttling and access logs; CORS is explicit.
- [ ] State machines log at least errors; execution data logging is a conscious PII decision.
- [ ] Code review: `visibilityTimeout ≥ 6 × timeout`; `maxConcurrency`/reserved concurrency justified; bundle has `minify` and externals reviewed.

## Interview angle

1. *"How do you deploy a Lambda change safely with CDK?"* — `currentVersion` publishes a version; an alias fronts it; `LambdaDeploymentGroup` hands the alias update to CodeDeploy with a canary/linear config and alias-scoped alarms; `autoRollback` on failure/alarm; API integrations and event sources point at the alias. Trade the extra minutes for blast-radius control.
2. *"Why put SQS between EventBridge and Lambda?"* — Buffering and back-pressure, batching, a DLQ with a defined `maxReceiveCount`, partial batch failure reporting, mapping-level concurrency, and metrics you can alarm on. Direct invocation retries for up to 24 h with none of that.
3. *"Explain Retry vs Catch in Step Functions and where compensation goes."* — Retry re-runs the same state for matching errors (transient); Catch transitions to another state for matching errors (permanent) and can preserve the error under `resultPath`. Compensation is the Catch target of the step whose side effect must be undone; make compensating steps idempotent and retryable too.

## References

- `aws-cdk-lib/aws-lambda-nodejs` (`NodejsFunction`, `BundlingOptions`), `aws-lambda/lib/function.d.ts` (`logGroup`, `loggingFormat`, `currentVersionOptions`), `aws-codedeploy/lib/lambda/deployment-group.d.ts`, `deployment-config.d.ts`.
- `aws-cdk-lib/aws-apigatewayv2` (`HttpApi`, `HttpStage`, `LogGroupLogDestination`), `aws-apigatewayv2-integrations` (`HttpLambdaIntegration`).
- `aws-cdk-lib/aws-lambda-event-sources/lib/sqs.d.ts`, `aws-events-targets/lib/sqs.d.ts`, `aws-sqs/lib/queue.d.ts`.
- `aws-cdk-lib/aws-scheduler`, `aws-scheduler-targets` (`LambdaInvoke`, `ScheduleTargetInput`, `TimeWindow`).
- `aws-cdk-lib/aws-stepfunctions` (`DefinitionBody`, `Choice`, `JsonPath`), `aws-stepfunctions-tasks` (`LambdaInvoke`, `DynamoPutItem`, `EventBridgePutEvents`).
- AWS docs: Lambda SQS event source (batch item failures, visibility timeout guidance); CodeDeploy Lambda deployment configurations; EventBridge Scheduler; Step Functions error handling.
