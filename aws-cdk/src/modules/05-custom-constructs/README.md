# 05 · Custom constructs & construct libraries

> After this module you can design an L3 construct whose API reads like one AWS wrote — typed props with defaults, `I*` interface + `from*Attributes`, `grant*` and `metric*`, validation and warnings — and you know the jsii rules and the projen/jsii publishing workflow that turn it into a library other teams (and other languages) can consume.

## Why this exists (the problem)

By module 04 every service stack contains the same fifty lines: a bucket with KMS, versioning, TLS-only, access logs and lifecycle; a queue with a DLQ, a Lambda, and two alarms; a dashboard that someone built by hand once and nobody updates. Copy-paste is how platform standards decay: the third copy drops the DLQ alarm, the fifth uses SSE-S3 because KMS "was annoying", and the security review finds twelve variations of "the standard bucket".

A construct library is how a platform team ships *decisions* instead of documents. The hard part is not the code — it is the API: what is a prop and what is a method, what is required, what an imported instance can do, how a consumer extends it without forking it, and what breaks when the library is compiled for Python or Java by jsii.

## Mental model

```mermaid
flowchart TB
  subgraph consumer [Service team's stack]
    D[ConstructsDemoStack]
  end
  subgraph lib [Platform construct library]
    SB[SecureBucket L3] --> B[s3.Bucket 'Resource'] --> BP[BucketPolicy]
    SB --> K[kms.Key]
    SB --> AL[s3.Bucket AccessLogs]
    QW[QueueWorker L3] --> Q[sqs.Queue] --> DLQ[sqs.Queue DLQ]
    QW --> F[lambda.Function + LogGroup]
    QW --> A1[Alarm DLQ depth]
    QW --> A2[Alarm oldest message]
    SD[ServiceDashboard L3] --> DB[cloudwatch.Dashboard]
    IQ[IQueueWorker interface] -.implemented by.-> QW
    IQ -.implemented by.-> IMP[QueueWorker.fromQueueWorkerAttributes]
  end
  D -->|new SecureBucket / grantRead / metricNumberOfObjects| SB
  D -->|new QueueWorker / grantSend / alarms| QW
  D -->|IMetric[] + IAlarm[]| SD
```

An L3 is a `Construct` subclass that composes L2s, exposes the important ones as `readonly` members, and offers the same verb conventions the L2s do. The interface (`IQueueWorker`) is the contract consumers code against; the class is one implementation; the `from*Attributes` import is another.

## How it works

### Designing the API (`secure-bucket.ts`, `queue-worker.ts`, `service-dashboard.ts`)

**Props naming and defaults.** One `XxxProps` interface per construct, every member `readonly`, every optional member documented with `@default`. Required props are only the ones with no safe default (`QueueWorkerProps.code`, `ServiceDashboardProps.serviceName/metrics`); `SecureBucketProps` has none, so `new SecureBucket(this, 'Docs')` is a valid, secure bucket. Name props after the *intent* (`transitionAfter`, `maxReceiveCount`), not the CloudFormation field. Nested option groups (`SecureBucketLifecycle`, `QueueWorkerAlarmThresholds`) are their own interfaces so they can be documented and reused.

**Choices are enums or static-factory classes, never unions.** `SecureBucketEncryption.KMS | S3_MANAGED` is an enum; exercise 3 shows the `NotifierEncryption.kms(key)` factory idiom that aws-cdk-lib uses everywhere (`ContainerImage.fromRegistry`, `Code.fromAsset`, `BucketEncryption`). Both survive jsii; `kms.IKey | 'managed'` does not.

**Expose the L2s.** `SecureBucket.bucket`, `QueueWorker.queue/deadLetterQueue/handler/logGroup`, `ServiceDashboard.dashboard` are public and readonly. The primary child is named `Resource` so `node.defaultChild` works (the test asserts it). Consumers get the whole L2 surface for the 10% you did not wrap, and you never need to subclass.

**`grant*` delegates; `metric*` builds `cloudwatch.Metric`.** `SecureBucket.grantRead(grantee)` calls `bucket.grantRead` — the IAM statements (including `kms:Decrypt` on the key) are exactly what the L2 produces. `metricNumberOfObjects()` returns a `Metric` with the right namespace, dimensions and a one-day period (S3 storage metrics are daily); callers compose it into alarms or dashboards. `QueueWorker.metricDeadLetterDepth()` and `metricOldestMessageAge()` are used both by the construct's own alarms and by the dashboard.

**`I*` interface + `from*Attributes`.** `IQueueWorker` lists what works on an imported worker: the three resource references, `grantSend`, `metric*`. `QueueWorker.fromQueueWorkerAttributes(scope, id, { queueArn, deadLetterQueueArn, functionArn })` returns an implementation built from `Queue.fromQueueArn` and `Function.fromFunctionArn`; the test checks it grants and produces metrics while creating zero resources, and that `alarms` (an *owned* concern) is not on the interface. The shared `QueueWorkerBase` keeps the derived members in one place for both the real and the imported class.

**Composition over inheritance.** Nothing here extends `s3.Bucket` or `sqs.Queue`. Subclassing an L2 ties you to its constructor signature and private behaviour across upgrades, and jsii forbids overriding most of it anyway. Wrap, expose, delegate. Where a consumer needs to *replace* a piece (their own KMS key, a shared access-log bucket), take it as a prop of the interface type (`kms.IKey`, `s3.IBucket`) — the "bring your own" test shows both.

**Validation in two places.** Constructor-time `throw` for props that make the object unusable (`accessLogsPrefix` without `/`, uppercase bucket name, `batchSize: 0`, `columns: 5`). `node.addValidation({ validate })` for checks that depend on the finished tree or on relationships between values: `SecureBucket` checks that noncurrent expiry exceeds the transition; `QueueWorker` reads the *L1 properties* of both queues so an escape-hatch edit to the DLQ retention still fails synth; `ServiceDashboard` uses the validation hook as its "finalise" step to lay out widgets added after construction. Synth failures carry the construct path: `[S/BadLifecycle] expireNoncurrentAfter (30d) must be greater than transitionAfter (90d)`.

**Warnings with stable ids.** `Annotations.of(this).addWarningV2('cdk-mastery:SecureBucket.s3ManagedEncryption', …)` — the id is namespaced so consumers can `acknowledgeWarning` it deliberately, and it appears as `[ack: <id>]` in the message. Use warnings for "allowed but you should know", errors for "will not deploy correctly".

### `ServiceDashboard` and `IMetric`

Accepting `cloudwatch.IMetric[]` (not `Metric[]`) is what lets callers pass `MathExpression`s and metrics from imported resources. The construct owns *layout* only: a header `TextWidget`, an `AlarmStatusWidget` when alarms are given, then rows of `GraphWidget`s `columns` wide. `addMetrics`/`addAlarms` work until synthesis; the validation hook renders once and later calls throw.

### jsii: the rules that bite (`solutions/exercise-3-jsii-compatible-api.ts`)

jsii compiles TypeScript to a language-neutral model so the same library ships to Python, Java, C# and Go. It accepts a strict subset of TypeScript:

| Rule | Why | What to do instead |
|---|---|---|
| No generics in public API | no mapping in Java/C#/Python | concrete types, behavioural interfaces |
| Unions only between primitives | other languages have no unions | enum, or a class with static factories |
| Props interface members must be `readonly` | structs are immutable data in other languages | `readonly` everywhere |
| Interfaces named `I*` are behavioural (implementable); others are structs (data only) | the name decides code generation | `IQueueWorker` has methods; `QueueWorkerProps` has only fields |
| No function-typed props / callbacks | no first-class functions in the model | an interface with one method (`INotificationHook`) |
| No anonymous object types in signatures | every type must be exported and named | export the interface |
| Only `Record<string, X>` maps, only arrays (no tuples, no `Set`) | model limits | `Record`, `X[]` |
| No overloads; optional params last; no `undefined` union in return types beyond `?` | model limits | one signature, optional trailing params |
| `static` members cannot share a name with instance members; class and interface names unique per module | code generation | distinct names |
| Public API must be documented (`/** */`), `@default` on optional props (`jsii` warns; Construct Hub scores it) | docs are generated | write them |

`jsii` reports each violation with the file and line; running it is the only reliable check, so the projen project below runs it on every build.

### projen + jsii publishing workflow

projen generates and owns the project files (`package.json`, `tsconfig`, `.github/workflows`, `.npmignore`) from a single `.projenrc.ts`; you never edit the generated files by hand. For a construct library:

```ts
// .projenrc.ts — describes the project; `npx projen` regenerates everything else.
import { awscdk, javascript } from 'projen';

const project = new awscdk.AwsCdkConstructLibrary({
  name: '@cdk-mastery/constructs',
  author: 'Platform Team',
  authorAddress: 'platform@example.com',
  repositoryUrl: 'https://github.com/example/cdk-mastery-constructs',
  defaultReleaseBranch: 'main',
  cdkVersion: '2.269.0',           // peer dependency floor; consumers may use newer
  constructsVersion: '10.8.1',
  jsiiVersion: '~5.9.0',            // jsii tracks TypeScript minors: 5.9 == TS 5.9
  projenrcTs: true,
  // Multi-language targets: each needs a registry account and CI secrets.
  publishToPypi: { distName: 'cdk-mastery-constructs', module: 'cdk_mastery_constructs' },
  publishToMaven: { javaPackage: 'com.example.cdkmastery', mavenGroupId: 'com.example', mavenArtifactId: 'cdk-mastery-constructs' },
  publishToNuget: { dotNetNamespace: 'Example.CdkMastery', packageId: 'Example.CdkMastery.Constructs' },
  publishToGo: { moduleName: 'github.com/example/cdk-mastery-constructs-go' },
  // Versioning: conventional commits drive semver; `feat:` = minor, `fix:` = patch, `!`/BREAKING = major.
  // Default release trigger: continuous release on every push to main.
  majorVersion: 1,
  npmAccess: javascript.NpmAccess.PUBLIC,
  // Quality gates: API surface is tracked in API.md; a change to it fails CI unless committed.
  docgen: true,
  eslint: true,
  prettier: true,
  devDeps: ['cdk-nag'],
  // Deprecated API elements are stripped from the build after a grace period.
  stability: 'stable',
});
project.synth();
```

The generated workflow: `build` (tsc via jsii → `.jsii` assembly + `lib/`), `test` (jest), `package` (`jsii-pacmak` produces the npm tarball, Python wheel, Maven jar, NuGet package, Go module), `release` (bumps version from conventional commits, tags, publishes to every configured registry using the CI secrets). `API.md` is generated by `jsii-docgen` and committed; a PR that changes the public API shows a diff there, which is your API review.

**Construct Hub** (constructs.dev) indexes every npm package that has a `.jsii` assembly, a `constructs` peer dependency and an open-source licence; it renders `API.md`-style docs per language and scores packages on documentation, `@default` coverage and language support. Publishing to npm with jsii is enough to appear there; the projen `keywords`/`description` and README become the listing.

**Semver for constructs.** Your public API is: every exported type, every prop, every method, *and the resources you synthesize*. Adding an optional prop or a method is a minor. Removing or renaming anything, changing a default, or changing a logical ID (renaming a child construct, re-scoping the `Resource`) is a **major** — the last two replace consumers' resources on the next deploy. Behavioural changes that alter templates without an API change (tightening a bucket policy) are at least a minor with a changelog entry and, for stateful resources, a major. `peerDependencies` on `aws-cdk-lib` and `constructs` use `^` floors so consumers control the exact version.

## Walkthrough

From `aws-cdk/`:

1. `secure-bucket.ts` — read the header comment, then the constructor; note the two validation styles and the warning ids.
2. `queue-worker.ts` — `IQueueWorker`, `QueueWorkerBase`, the static import, then the constructor.
3. `service-dashboard.ts` — the validation hook as a finalise step.
4. `demo-stack.ts` and `index.ts` — `npx cdk synth M05-Constructs --quiet && grep -c '"Type"' cdk.out/M05-Constructs.template.json` (≈ 25 resources from three constructor calls).
5. `test/05-custom-constructs.test.ts` — `npx jest test/05-custom-constructs.test.ts`.
6. `solutions/exercise-3-jsii-compatible-api.ts` — the before/after of a jsii cleanup.

`M05-Constructs` is env-agnostic. Tests set `@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy` (on in `cdk.json`) because `SecureBucket` uses `BUCKET_OWNER_ENFORCED` on the log bucket, which is incompatible with the legacy ACL-based delivery.

## Production notes

- **Defaults are policy.** `SecureBucket` defaults to KMS, `RETAIN`, versioning and TLS 1.2; opting out is possible but leaves a warning with an id in the assembly's metadata, which a validation plugin or cdk-nag can turn into a gate (module 06).
- **Keys cost money.** One CMK per bucket is ~$1/month plus API calls; `bucketKeyEnabled` cuts KMS calls by ~99%. For many small buckets accept a shared key via `encryptionKey`.
- **Library versioning is a deployment event.** Bumping the library in a consumer can rename logical IDs if the library changed a child id. Publish a `cdk diff` in the library's changelog for any change to construct ids, and keep an `overrideLogicalId` shim when you must rename.
- **Imported instances cannot be validated.** `fromQueueWorkerAttributes` trusts the ARNs; a typo fails at deploy (or worse, grants on the wrong queue). Validate ARN shape in the factory when practical (`Stack.of(scope).splitArn`).
- **Dashboards have a 500 KB body limit and 100 widgets** — `ServiceDashboard` is per service on purpose.
- **Alarms need actions.** `QueueWorker` creates alarms with no actions; exercise 1 wires them. A library should not assume the on-call topic; accept it as a prop or expose `alarms`.
- **Monitor the library itself**: Construct Hub score, jsii warnings on build, and the `API.md` diff in every PR.

## Gotchas

- Symptom: jsii `Type X is a union of non-primitive types` → cause: `A | B` in a public type → fix: enum or static-factory class.
- Symptom: jsii `Interface members must be readonly` → cause: mutable prop → fix: `readonly`.
- Symptom: jsii `Cannot use generics` / `Unable to resolve type` for an inline object → cause: generics or anonymous types in the public surface → fix: exported interfaces.
- Symptom: consumers in Python cannot pass a callback → cause: function-typed prop compiled to nothing usable → fix: a behavioural `I*` interface.
- Symptom: `There is already a Construct with name 'Resource'` → cause: two primary children named `Resource` in one construct → fix: only the primary L2 is `Resource`; name the others.
- Symptom: `objectOwnership must be set to "ObjectWriter" when accessControl is "LogDeliveryWrite"` → cause: `serverAccessLogsUseBucketPolicy` flag missing (bare test App) → fix: pass the flag in test context.
- Symptom: a validation that inspects an L1 does not see an `addPropertyOverride` → cause: raw overrides apply at render time → fix: use typed L1 setters (`cfnQueue.messageRetentionPeriod = …`) for values validations must see.
- Symptom: `cannot add metrics after synthesis` → cause: `addMetrics` after `Template.fromStack`/`app.synth()` → fix: add before; synthesis freezes the tree.
- Symptom: library minor bump replaced a consumer's queue → cause: a child construct id changed → fix: treat construct ids as API; major version; `overrideLogicalId` shim.

## Exercises

1. **Alarm fan-out.** Write `notifyOnAlarm(target, topic)` for anything exposing `alarms: Alarm[]`, with optional OK actions. Solution: `solutions/exercise-1-alarm-actions.ts`.
2. **`ISecureBucket` + `fromSecureBucketAttributes`.** Import a bucket by ARN with an optional key ARN; make `grantRead` include KMS permissions only when the key is known and warn otherwise. Solution: `solutions/exercise-2-import-secure-bucket.ts`.
3. **jsii cleanup.** Take a props interface with a generic target, a mutable field, a union of a class and string literals, and a callback; rewrite it with a behavioural target interface, `readonly` props, a static-factory class and a hook interface. Solution: `solutions/exercise-3-jsii-compatible-api.ts`.

## Checklist

- [ ] Every construct: `XxxProps` with `readonly` members and `@default` docs; no required prop that has a safe default.
- [ ] Primary L2 exposed and named `Resource`; other L2s exposed as `readonly` members.
- [ ] `grant*` delegates to L2s; `metric*` returns `cloudwatch.Metric` with correct namespace/dimensions/period.
- [ ] `I*` interface lists only what works on an imported instance; `from*Attributes` exists for anything consumed across stacks/apps.
- [ ] Constructor throws for unusable props; `node.addValidation` for relationships; warnings carry namespaced ids.
- [ ] No generics, unions of non-primitives, mutable props, callbacks or anonymous types in the public API (run `jsii`).
- [ ] Child construct ids are treated as API; renames are majors with a migration note.
- [ ] Code review: no `extends s3.Bucket`-style inheritance of L2s; `bring-your-own` props typed as `I*`.

## Interview angle

1. *"How do you design the API of a reusable construct?"* — Props interface with readonly fields and documented defaults; required only what cannot default; enums/static factories for choices; expose composed L2s; `grant*`/`metric*`/`connections` verbs; an `I*` interface and `from*Attributes` for imports; validation at construction for local errors and `addValidation` for relationships; namespaced warnings. Composition, never inheritance.
2. *"What changes when you publish it with jsii?"* — The public surface must fit the jsii type model: no generics, no non-primitive unions, readonly struct props, behavioural interfaces instead of callbacks, named exported types only. projen generates the build/release pipeline, `jsii-pacmak` produces per-language packages, `API.md` becomes the API review artefact, Construct Hub indexes it.
3. *"What is a breaking change for a construct library?"* — Anything that changes consumers' synthesized templates in an incompatible way, not just the TypeScript API: removed/renamed props or methods, changed defaults, and especially changed child construct ids (logical-ID replacement). Semver majors for those; changelog with a diff.

## References

- `aws-cdk-lib/aws-s3/lib/bucket.d.ts` (the reference `IBucket`/`fromBucketAttributes`/`grant*` design), `aws-sqs/lib/queue-base.d.ts` (`metric*` conventions), `aws-cloudwatch/lib/dashboard.d.ts`, `graph.d.ts`, `alarm-status-widget.d.ts`.
- `constructs` package: `Node.addValidation`, `Node.defaultChild`; `aws-cdk-lib/core/lib/annotations.d.ts`.
- jsii: aws.github.io/jsii — "TypeScript restrictions"; `jsii-docgen`, `jsii-pacmak`.
- projen: projen.io — `awscdk.AwsCdkConstructLibrary` options; Construct Hub: constructs.dev (contributing guide and scoring).
- CDK Developer Guide: "Best practices for developing and deploying cloud infrastructure with the AWS CDK" → construct best practices.
