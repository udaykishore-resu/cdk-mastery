# Gotchas

> Symptom → cause → fix. Grouped by theme, AWS CDK first, then CDKTF/GCP. Versions: `aws-cdk-lib` 2.269.0, CLI 2.1141.0, `cdktf` 0.21.0, `hashicorp/google` 6.50.0 via `@cdktf/provider-google` 16.12.1. Each module README has its own gotchas section for module-specific ones; this file is the cross-cutting set. Theory in the [MASTERY-GUIDE](MASTERY-GUIDE.md); commands in the [CHEATSHEET](CHEATSHEET.md).

---

## AWS CDK

### Tokens

**A1. `bucket.bucketName.length` is 16 (or some other nonsense) and a `substring`/`toUpperCase` produced garbage in the template.**
- **Cause:** the value is a token (`${Token[TOKEN.42]}`) at synth time; string methods operate on the placeholder.
- **Fix:** never do string logic on values that may be tokens; guard with `Token.isUnresolved(x)`; push the transformation to CloudFormation (`Fn.select(0, Fn.split('-', x))`) or pass a concrete value in via props. Module [A01](../aws-cdk/src/modules/01-constructs-and-tokens/README.md).

**A2. `if (stack.region === 'us-east-1')` is never true, or is always true.**
- **Cause:** in an env-agnostic stack `region` is the token `{ Ref: AWS::Region }`; comparison against a literal is always false; `if (stack.region)` is always truthy.
- **Fix:** pass a concrete `env` so `region` is a string, or use `Token.compareStrings`/`CfnCondition` for deploy-time branching.

**A3. `JSON.stringify({ arn: role.roleArn })` puts `${Token[...]}` in an IAM policy / Lambda env var.**
- **Cause:** plain JSON serialisation does not resolve tokens.
- **Fix:** `stack.toJsonString(obj)` (renders `Fn::Join` around intrinsics) or let the L2 (`PolicyDocument`) render it.

**A4. A `Lazy` produced a stale value, or a validation error says a list is empty even though you pushed to it.**
- **Cause:** `Lazy.string`/`list` are cached after the first `produce` call, which happens in the prepare phase (reference resolution) *before* validation; `Lazy.uncachedString` re-runs. Also, an array captured by reference is fine, but a value copied at construction time is frozen.
- **Fix:** produce from live state; use the `uncached*` variants when the value legitimately changes between prepare and synth; never rely on validation having run inside a producer.

**A5. Passing a token where a number is expected: "Cannot convert token to number" or a negative magic number in the template.**
- **Cause:** number tokens are encoded as specific negative doubles; arithmetic on them (`token + 1`) produces a non-token.
- **Fix:** `Token.asNumber` only wraps; do arithmetic in CloudFormation (rare) or keep the value concrete.

### Logical IDs and identity

**A6. Renaming a construct id, or wrapping a resource in a new construct, replaced a database/bucket/queue.**
- **Cause:** logical ID = hash of the construct path; the path changed, so CloudFormation sees delete + create; `RemovalPolicy.DESTROY` (the default for many L2s) let it happen.
- **Fix:** before any refactor, `cdk diff` and look for `[-]`/`[+]` pairs and "replacement" markers; preserve IDs with `(x.node.defaultChild as CfnResource).overrideLogicalId(old)` or `stack.renameLogicalId(old, new)`; set `RemovalPolicy.RETAIN` on stateful resources (module A06 does it with an aspect); use `cdk refactor --unstable=refactor --dry-run` to compute the mapping. Module [A01](../aws-cdk/src/modules/01-constructs-and-tokens/README.md), [A10](../aws-cdk/src/modules/10-escape-hatches-custom-resources-and-migration/README.md).

**A7. Two constructs with ids `A-B` and `AB` collide: "There is already a Construct with name ... " or duplicate logical ID.**
- **Cause:** non-alphanumerics are stripped when the logical ID is computed, so top-level `A-B` and `AB` render the same.
- **Fix:** use PascalCase ids without punctuation (the `PascalCaseIds` rule in `shared/src/policy.ts` enforces it).

**A8. Reordering array elements in an L2 prop (security group rules, GSIs, lifecycle rules) caused a replacement or a "cannot update" error.**
- **Cause:** some CloudFormation properties are identified by position, some by name; L2s sometimes derive child construct ids from an index (`Rule0`).
- **Fix:** read the L2 source for how the child id is derived; add new elements at the end; for DynamoDB GSIs never rename and add/remove one at a time.

**A9. Changing `Table` → `TableV2` (or any construct type swap) wants to replace the table.**
- **Cause:** different resource type (`AWS::DynamoDB::Table` → `AWS::DynamoDB::GlobalTable`); CloudFormation cannot convert in place.
- **Fix:** `cdk orphan --unstable=orphan Stack/MyTable` (sets Retain, removes from template), change the code, `cdk import --resource-mapping-inline '{"MyTable...":{"TableName":"..."}}'`. `TableV2` has been the recommended construct since 2.95.0 (2023-09).

### Cross-stack references and state

**A10. "Export X cannot be deleted as it is in use by StackB" when deploying after removing a reference.**
- **Cause:** strong references: the same synth removes the export from the producer and the import from the consumer; deploying the producer first violates the export.
- **Fix:** `producer.exportValue(resource.attr)` to keep the export for one deploy, deploy both, then remove; or switch to weak references (`@aws-cdk/core:defaultCrossStackReferences: "both"` → deploy → `"weak"` → deploy; 2.254.0+). Module [A02](../aws-cdk/src/modules/02-stacks-environments-and-references/README.md).

**A11. "Stack "A" cannot reference {resource} in stack "B" — different environments / cross-region."**
- **Cause:** references only work between stacks in the same account+region unless `crossRegionReferences: true` is set on both, and never from/to an env-agnostic stack.
- **Fix:** set explicit `env` and `crossRegionReferences`, or share via SSM parameters / `Fn.importValue` with a manual export name.

**A12. A cyclic dependency error between two stacks that "obviously" is not cyclic.**
- **Cause:** an L2 helper (`grant*`, `addEventNotification`, `connections.allowFrom`) added a resource *in the other stack's scope* (e.g. a bucket policy or a security-group ingress is created in the *target's* stack), so each stack now references the other.
- **Fix:** put the two resources in one stack, or import the target with `fromXxxAttributes` in the consumer and grant manually there, or move the policy to the correct side explicitly (`Bucket.fromBucketArn(...).grantRead(...)` creates the policy on the *role*, not the bucket).

**A13. `Vpc.fromLookup` returned stale subnets / a deleted VPC, or CI fails with "Context lookups have been disabled".**
- **Cause:** lookup results are cached in `cdk.context.json` forever; CI with `--lookups=false` refuses to look up anything not cached.
- **Fix:** commit `cdk.context.json`; refresh with `cdk context --reset 'vpc-provider:...'` when infra changes; run lookups on a laptop or a dedicated job with the lookup role.

**A14. `UPDATE_ROLLBACK_FAILED` and `cdk deploy` refuses to continue.**
- **Cause:** a rollback could not undo a resource (non-empty bucket, ENI attached, custom resource handler broken).
- **Fix:** `cdk rollback --orphan <LogicalId>` (or `--force`) to skip the failing resources, or `aws cloudformation continue-update-rollback --resources-to-skip`; then fix the root cause and redeploy. Prevention: `--no-rollback` in dev to keep the failure state inspectable; keep custom-resource `Delete` handlers idempotent.

**A15. `cdk deploy --hotswap` "worked" and then a normal deploy showed no changes but prod still runs old code — or the reverse.**
- **Cause:** hotswap updates the resource directly, bypassing CloudFormation; the stack's template still holds the previous asset hash, so drift exists until the next real deploy of a *changed* hash.
- **Fix:** hotswap only in dev; never in a pipeline; `cdk drift` will show it.

### Assets and bootstrap

**A16. "This CDK CLI is not compatible with the CDK library used by your application" or "Cloud assembly schema version mismatch".**
- **Cause:** `aws-cdk-lib` newer than the CLI; the assembly schema (54.x) is versioned independently since the 2025-02 CLI split.
- **Fix:** upgrade `aws-cdk` (the CLI is backwards compatible; the library is not forwards compatible); pin both in `package.json`.

**A17. "Need to perform AWS calls for account X, but no credentials found" during `cdk synth` in CI.**
- **Cause:** a lookup (`fromLookup`, `valueFromLookup`, `Vpc`'s AZ lookup for an explicit env) needs credentials at synth.
- **Fix:** commit `cdk.context.json`; or give the synth job the lookup role; or avoid lookups in favour of `fromXxxAttributes`/context values.

**A18. "SSM parameter /cdk-bootstrap/hnb659fds/version not found" or "CDK bootstrap stack version 6 required".**
- **Cause:** the target env is not bootstrapped, is bootstrapped under a different qualifier, or with an older template.
- **Fix:** `cdk bootstrap aws://ACCT/REGION` (v32 ships with CLI 2.1141); match `DefaultStackSynthesizer({ qualifier })` to `--qualifier`; features need minimums (import ≥ 12, rollback ≥ 23).

**A19. Assets rebuild on every synth (Docker/esbuild) and every deploy shows a Lambda change with no code change.**
- **Cause:** the asset hash includes something nondeterministic (timestamps in a zip, `Date.now()` in a build arg, a `node_modules` tree that differs between machines, Docker layer metadata).
- **Fix:** `assetHashType: OUTPUT` for bundled assets, deterministic bundling (`esbuild` with fixed target, `--platform`), `exclude` patterns, `--build-exclude` in CI, `.dockerignore`.

**A20. Bundling fails in CI with "docker: not found" or "spawnSync docker ENOENT".**
- **Cause:** `NodejsFunction`/`PythonFunction`/`DockerImageAsset` bundle in Docker when a local bundler is absent.
- **Fix:** install `esbuild` locally so `NodejsFunction` bundles without Docker; for others, a runner with Docker, or `local: ILocalBundling` with `tryBundle`. `bundlingFileAccess: BundlingFileAccess.VOLUME_COPY` for Docker-in-Docker runners where bind mounts fail.

**A21. The bootstrap bucket is huge; `cdk gc` is not found or refuses to run.**
- **Cause:** assets are never deleted; `gc` is gated.
- **Fix:** `cdk gc --unstable=gc --action=print`, then `--action=tag`, then `--action=delete-tagged --rollback-buffer-days=30`; a lifecycle rule for non-current versions on the bucket (the bucket is versioned).

### IAM and security

**A22. A role's `DefaultPolicy` grew past the 10,240-character inline policy limit, or a grant produced `Resource: "*"`.**
- **Cause:** every `grant*` appends a statement to the principal's default policy; some grants (KMS via alias, services without resource-level permissions, `grant*` on a resource imported without an ARN) legitimately need `*`.
- **Fix:** `@aws-cdk/aws-iam:minimizePolicies: true` (in this repo's `cdk.json`) merges statements; import resources with full ARNs (`fromBucketAttributes`), split roles per function, or move shared grants to a `ManagedPolicy`; cdk-nag `AwsSolutions-IAM5` flags the wildcards so each gets a reason.

**A23. The deploy works from a laptop with admin credentials and fails in the pipeline with `AccessDenied` on `iam:CreateRole` / `PassRole`.**
- **Cause:** the pipeline's role can only assume the bootstrap roles; the cfn-exec role has the narrowed `--cloudformation-execution-policies` or a permission boundary that forbids creating roles without the boundary.
- **Fix:** apply `PermissionsBoundary.fromName(...)` on the Stage/Stack so CDK attaches the boundary to every role it creates; extend the exec policy deliberately, not to `AdministratorAccess`.

**A24. Lambda log groups are created by the service with infinite retention and no tags; `logRetention` creates a custom resource you did not expect.**
- **Cause:** the pre-flag default let Lambda create the group on first invoke; `logRetention` uses a `LogRetention` custom resource.
- **Fix:** `@aws-cdk/aws-lambda:useCdkManagedLogGroup: true` (2.200.0+) so CDK owns a `LogGroup` that tags/aspects/injectors apply to; or pass `logGroup: new LogGroup(...)` explicitly.

**A25. `Tags.of(stack).add(...)` applied the tag twice, and `excludeResourceTypes` had no effect on stack-level tags.**
- **Cause:** stack tags propagate to every resource via CloudFormation *and* the Tags aspect tagged each resource.
- **Fix:** `@aws-cdk/core:explicitStackTags: true` (2.205.0+) and set stack tags via `StackProps.tags`; use `Tags.of(scope)` on constructs below the stack.

### Aspects and governance

**A26. Your aspect set a property and the library "un-set" it, or two aspects fight non-deterministically.**
- **Cause:** before 2.172.0 aspects ran in one pass, closest-to-target last; now priority decides (`MUTATING` 200 < `DEFAULT` 500 < `READONLY` 1000) and same-priority order is not guaranteed.
- **Fix:** give mutating aspects `AspectPriority.MUTATING` and checks `READONLY`; turn on `@aws-cdk/core:aspectPrioritiesMutating` so library aspects run first; do not rely on ordering among equal priorities. Module [A06](../aws-cdk/src/modules/06-aspects-tags-and-governance/README.md).

**A27. An aspect that adds a construct does not get visited itself / the added construct is not tagged.**
- **Cause:** without `@aws-cdk/core:aspectStabilization` the tree is walked once.
- **Fix:** enable the flag (default in new `cdk.json`); aspects that add constructs should apply needed aspects to what they add.

**A28. cdk-nag 3: `NagSuppressions is not exported` after upgrading from 2.x.**
- **Cause:** cdk-nag 3.0.0 (2026-06-12) removed `NagSuppressions` in favour of core `Validations`.
- **Fix:** `Validations.of(app).addPlugins(new AwsSolutionsChecks(app))` and `Validations.of(construct).acknowledge({ id, reason })`; `appliesTo` became per-finding ids like `AwsSolutions-IAM5[Action::s3:*]`; findings now land in `validation-report.json`; use `writeSuppressionsToCloudFormation: true` to keep the v2 metadata for auditors.

**A29. cdk-nag passes locally but the resource is non-compliant, because the fix was an `addPropertyOverride`.**
- **Cause:** raw overrides are applied after the L1 renders; rule packs read the L1 properties.
- **Fix:** prefer the typed L1 property (`cfn.propertyName = ...`), and acknowledge the rule with a reason that names the override.

### Testing

**A30. `Template.fromStack(stack)` throws about a cyclic dependency, or a test that mutates the tree after a first `fromStack` sees no change.**
- **Cause:** `Template.fromStack` synthesizes the enclosing app/stage and the assembly is cached; constructs added after the first synthesis are not rendered, and a stack that references another stack you did not instantiate fails the cyclic/dependency checks.
- **Fix:** build a fresh `App` per test; use `skipCyclicalDependenciesCheck` only when testing a stack that references another you are not instantiating.

**A31. Snapshot tests fail on every commit because of asset hashes, `CDKMetadata`, or bootstrap version rules.**
- **Cause:** hashes change with code; `CDKMetadata` is off in tests but analytics metadata may not be.
- **Fix:** snapshot only the stable subset (`template.findResources('AWS::Lambda::Function')` minus `Code`), or a custom jest serializer that replaces `[0-9a-f]{64}` with `HASH`; set `analyticsReporting: false` on the `App` in tests.

**A32. `hasResourceProperties` fails for an array property that is "obviously there".**
- **Cause:** arrays must match in full length and order; objects match partially.
- **Fix:** `Match.arrayWith([...])` for subset, `Match.objectLike` inside array elements, `Match.absent()` for "must not exist".

### CLI, versions and flags

**A33. Synth takes 30–60 seconds before anything happens.**
- **Cause:** `npx ts-node --prefer-ts-exts bin/app.ts` type-checks the whole program on every command; big `aws-cdk-lib` import graphs are slow.
- **Fix:** `ts-node --transpile-only` (`TS_NODE_TRANSPILE_ONLY=1`) or `tsx` in `cdk.json` `app`; or `"build": "tsc"` + `"app": "node dist/bin/app.js"`; import per-module paths (`aws-cdk-lib/aws-s3`) rather than the barrel; `--app cdk.out` for repeated `deploy`/`diff` after one `synth`.

**A34. A library upgrade changed a template with no code change (new defaults, new resources such as `AWS::Lambda::LogGroup`, changed IAM).**
- **Cause:** feature flags default to *old* behaviour only for flags introduced after your `cdk.json` was generated; L2 defaults do change under existing flags; new L2 versions add resources.
- **Fix:** treat every `aws-cdk-lib` bump as an infrastructure change with a reviewed `cdk diff`; read `cdk.out/manifest.json`'s feature-flag report; `cdk flags --unstable=flags` to see recommended vs current.

**A35. `cdk refactor`, `cdk gc`, `cdk orphan`, `cdk flags`, `cdk diagnose`, `cdk validate` fail with "Unstable feature use".**
- **Cause:** gated commands in CLI 2.1141.
- **Fix:** `--unstable=<command>`; treat their flags as subject to change; do not script them without pinning the CLI.

**A36. `cdk deploy` exit code is 0 but a stack was skipped ("no changes"), or `cdk diff --fail` exits 1 in CI and the job fails.**
- **Cause:** by design: `diff --fail` returns 1 on differences (without `--fail` the 2.1141 CLI exits 0 despite the legacy help text); `deploy` skips unchanged stacks unless `--force`.
- **Fix:** in CI, decide explicitly: `cdk diff --fail` to gate, or plain `cdk diff` to report; `--force` to redeploy an unchanged template (rarely needed, e.g. to re-run a custom resource — better: change a property).

**A37. `cdk deploy` fails with a template larger than 51,200 bytes / "Template format error: too many resources".**
- **Cause:** CloudFormation limits: 1 MB template via S3 (the bootstrap bucket makes that automatic), 500 resources per stack, 200 outputs/parameters/mappings.
- **Fix:** split stacks or use `NestedStack`; `suppressTemplateIndentation` shrinks bytes but not counts.

---

## CDKTF and the Google provider

### Tokens and expressions

**B1. A resource attribute is typed `string` but the value in `cdk.tf.json` is a literal `${TfToken[TOKEN.7]}`.**
- **Cause:** a token escaped resolution because it went through a path CDKTF does not resolve (a `Map`, a `JSON.stringify`, a value captured in an aspect *before* the resource had its address).
- **Fix:** pass tokens straight through props; use `Fn.jsonencode` for JSON; avoid manipulating token strings. Module [B01](../cdktf-gcp/src/modules/01-providers-resources-and-tokens/README.md).

**B2. TypeScript refuses `bucket.name` where a `string[]` is needed, or a `DataGoogleComputeZones.names` element cannot be indexed with `[0]`.**
- **Cause:** computed lists are token lists; `[0]` on them works only for lists whose length is known at synth (it is not).
- **Fix:** `Fn.element(list, 0)`, `Token.asString(propertyAccess(list, [0]))`; `Token.asList(...)` to satisfy the type when you *know* the shape.

**B3. `${google_x.y.id}` appears inside another `${...}` producing `${"${...}"}` or an "Invalid template interpolation" error.**
- **Cause:** double interpolation from string-building tokens inside `Fn.*` arguments that already interpolate, or from `rawString` misuse.
- **Fix:** pass tokens to `Fn.*` directly (no template literals inside function calls); use `Fn.rawString` only for literal `${` you want Terraform to see.

**B4. `for_each` resource: "The given "for_each" argument value is unsuitable... set of string / map".**
- **Cause:** `TerraformIterator.fromList` over a list of objects; Terraform wants a set of strings or a map.
- **Fix:** `TerraformIterator.fromMap` with an object keyed by a stable key, or `fromComplexList(list, 'name')` for computed lists of objects; never key on an index (renumbering replaces everything).

**B5. A `count`/`for_each` resource cannot be referenced with `.id` — "Because google_x.y has "for_each" set, its attributes must be accessed on specific instances".**
- **Cause:** the resource is now a map/list of instances.
- **Fix:** `TerraformIterator.fromResources(resource)` to iterate the instances, or `Fn.lookup(resource.fqn ...)`/`propertyAccess(resource, ['key', 'id'])`; often better to loop in TypeScript when the set is synth-time known (each instance gets its own address and can be referenced normally).

### Logical IDs and identity

**B6. Renaming a construct id or wrapping a resource in a construct destroyed and recreated it.**
- **Cause:** the Terraform address is derived from the construct path (`vpc_subnet_ABCD1234` style); a new address is a new resource.
- **Fix:** `resource.moveTo('target')` with `addMoveTarget('target')` on the new resource (renders a `moved` block; Terraform ≥ 1.1), or `overrideLogicalId(old)`; review `cdktf diff` for `-/+` before applying. Module [B10](../cdktf-gcp/src/modules/10-escape-hatches-hcl-migration-and-interop/README.md).

**B7. After upgrading a very old project past `cdktf` 0.17, every resource shows as replaced.**
- **Cause:** 0.17 removed the pre-0.15 logical-ID scheme (ids computed from the app root, separators stripped); the state has the old addresses.
- **Fix:** `Aspects.of(stack).add(new MigrateIds())` (shipped in `cdktf`) once — it emits a `moved` block from each old address to the new one and prints `terraform state mv` commands for modules — apply, then remove the aspect.

**B8. Two resources with ids `db` and `DB` (or `a-b` and `a_b` at top level) collide.**
- **Cause:** top-level ids are used verbatim minus disallowed characters; case-sensitive, but `a-b`/`a_b` differ only if both characters survive (`-` and `_` both do); `a.b` and `ab` collide.
- **Fix:** lowercase-with-hyphen ids, no dots.

### State, backends and references

**B9. `cdktf deploy svc` says stack `net` must be deployed too / "Usage Error: The following dependencies are not included in the stacks to run".**
- **Cause:** a cross-stack reference created a manifest dependency.
- **Fix:** `cdktf deploy '*'` or list both; `--ignore-missing-stack-dependencies` only when `net` is already deployed and unchanged.

**B10. Cross-stack reference works locally and fails in CI with "Unsupported attribute" or empty outputs.**
- **Cause:** the producer's backend is local (state on the laptop), or the consumer's identity cannot read the producer's state object.
- **Fix:** remote backend for every stack that is referenced; grant the consumer's SA `roles/storage.objectViewer` on the producer's state prefix. Module [B02](../cdktf-gcp/src/modules/02-state-backends-and-environments/README.md).

**B11. "Error acquiring the state lock" that never clears.**
- **Cause:** a killed run left the GCS lock object (`<prefix>/<name>.tflock`).
- **Fix:** confirm nothing is running, then `terraform force-unlock <ID>` from `cdktf.out/stacks/<id>` (or delete the lock object); add `TF_IN_AUTOMATION` and a CI concurrency group so it does not recur.

**B12. Changing the backend (bucket/prefix) makes `cdktf diff` fail with "Backend configuration changed".**
- **Cause:** `.terraform/` remembers the previous backend.
- **Fix:** `cdktf diff --migrate-state` (copies state to the new backend), or `terraform init -reconfigure` to point without copying. Never change `prefix` casually: it is the state's address.

**B13. `terraform.tfstate` appeared in `cdktf.out/stacks/<id>/` and got committed.**
- **Cause:** no backend declared → local backend.
- **Fix:** a `GcsBackend` on every stack, `cdktf.out` in `.gitignore` (it is), `App({ skipBackendValidation: false })` (default) so cross-stack consumers of a local-backend stack fail loudly.

**B14. Outputs of another stack read via remote state are `sensitive` and `cdktf output` prints `<sensitive>`.**
- **Cause:** CDKTF marks auto-generated cross-stack outputs `sensitive: true`.
- **Fix:** `cdktf output --outputs-file f.json --outputs-file-include-sensitive-outputs`; declare your own non-sensitive `TerraformOutput` for values humans need.

**B15. Apply failed halfway; re-running says a resource "already exists" (409).**
- **Cause:** Terraform created the object but did not record it (state write failed, or the API returned an error after creating).
- **Fix:** `resource.importFrom(id)` (or `terraform import` in the stack dir) to adopt it, then remove the call; for buckets/projects/service accounts this is the normal recovery, not an anomaly.

### Provider quirks on GCP

**B16. `ProjectIamBinding` removed everyone else with that role; `ProjectIamPolicy` removed *every* binding in the project, including the ones GCP services need.**
- **Cause:** `*_iam_member` is additive (one principal, one role); `*_iam_binding` is authoritative for *that role* (replaces all members); `*_iam_policy` is authoritative for the *whole* policy.
- **Fix:** default to `*IamMember`; use `*IamBinding` only when you own every member of that role; treat `*IamPolicy` as a break-glass tool; never mix member and binding for the same role in the same project. Module [B04](../cdktf-gcp/src/modules/04-serverless-and-events/README.md).

**B17. "Error 403: ... API has not been used in project ... before or it is disabled" on first apply, then it works on retry.**
- **Cause:** API enablement (`ProjectService`) is eventually consistent (seconds to minutes) and resources do not automatically depend on it.
- **Fix:** `dependsOn: [service]` from each resource (or the construct) to the `ProjectService`; enable `serviceusage.googleapis.com` and `cloudresourcemanager.googleapis.com` first; a `time_sleep` after enablement for the worst offenders (Cloud Run, Eventarc). Set `disableOnDestroy: false` so destroying one stack does not disable an API another stack uses.

**B18. "Error 400: Service account ... does not exist" right after creating it, or an IAM binding on a fresh SA fails.**
- **Cause:** IAM eventual consistency; the SA exists but is not yet visible to `setIamPolicy`.
- **Fix:** `dependsOn` plus a `time_sleep` (30–60 s) between `ServiceAccount` and the first binding; the provider retries some cases, not all.

**B19. `cdktf destroy` fails: "deletion_protection is set to true" (Cloud SQL, Cloud Run v2, BigQuery table, Secret Manager), or `google_project` refuses with `PREVENT`.**
- **Cause:** provider 6.x defaults: `SqlDatabaseInstance.deletionProtection` true, `CloudRunV2Service.deletionProtection` true, `BigqueryTable.deletionProtection` true, `Project.deletionPolicy` `PREVENT`.
- **Fix:** set them from the environment tier (`retainStatefulResources`), apply the change *first* (a plan that flips the flag and deletes in one step fails), then destroy; keep them on in prod on purpose.

**B20. A bucket delete fails: "The bucket you tried to delete is not empty".**
- **Cause:** `forceDestroy` defaults false.
- **Fix:** `forceDestroy: !tier.retainStatefulResources`; note soft-delete retention (7 days default on new buckets) keeps objects billable after deletion; set `softDeletePolicy: { retentionDurationSeconds: 0 }` where allowed.

**B21. Bucket name "already exists" (409) immediately after destroying it, or a project ID "already in use" long after deletion.**
- **Cause:** GCS bucket names are global and the old name is unavailable for a while after deletion (and forever if someone else grabs it); a deleted project sits in soft-delete for 30 days and its project ID can **never** be reused afterwards.
- **Fix:** derive names with a stable suffix (`resourceName` + `RandomId` from the `random` provider stored in state), never plan on reusing a project ID.

**B22. Every plan shows a change to `labels`/`effective_labels`/`terraform_labels`, or a diff you did not make.**
- **Cause:** provider 5.x+ splits user labels from effective labels; something else (a GKE controller, a policy engine) adds labels; or `defaultLabels` on the provider plus explicit labels.
- **Fix:** read `effectiveLabels` only; put org-wide labels in provider `defaultLabels`; `lifecycle: { ignoreChanges: ['labels'] }` on resources another system manages.

**B23. Cloud SQL private IP: "Failed to create subnetwork. Couldn't find free blocks in allocated IP ranges" or `ServiceNetworkingConnection` cannot be destroyed while an instance exists.**
- **Cause:** Private Service Access needs a reserved `ComputeGlobalAddress` (purpose `VPC_PEERING`, /16 or so) and the peering connection; destroy order is instance → connection → address.
- **Fix:** explicit `dependsOn`; `ServiceNetworkingConnection.deletionPolicy: 'ABANDON'` when the peering is shared. Module [B03](../cdktf-gcp/src/modules/03-networking-and-compute/README.md).

**B24. Cloud Run v2 service works, then the next apply replaces it or fails on `template.containers[0].image` drift.**
- **Cause:** an external deploy (Cloud Build, `gcloud run deploy`) changed the image; Terraform wants to revert.
- **Fix:** decide the owner: if CI deploys images, `lifecycle: { ignoreChanges: ['template[0].containers[0].image'] }` (the path uses `[0]` on blocks in Terraform's syntax); if Terraform deploys images, feed the digest as a variable.

**B25. `google-beta` fields ignored / "Unsupported argument" for a beta-only attribute.**
- **Cause:** the field exists only in `@cdktf/provider-google-beta` and the resource must be created with the beta provider.
- **Fix:** `new GoogleBetaProvider(this, 'google-beta', {...})` and `provider: beta` on that resource (the beta binding is a separate class, e.g. `@cdktf/provider-google-beta/lib/google-compute-network`).

**B26. A resource in another project fails with 403 even though the SA has the role there.**
- **Cause:** quota/billing project: some APIs bill the *caller's* project; the provider needs `userProjectOverride: true` and `billingProject` for those, and the SA needs `serviceusage.serviceUsageConsumer` on the billing project.
- **Fix:** set them on the provider (or an alias).

**B27. Org policy / folder IAM resources apply out of order and fail with "permission denied" for the deploy SA itself.**
- **Cause:** you are changing IAM that governs the identity applying it; the `google_project_iam_member_remove` or an authoritative policy removed the deploy SA's own role.
- **Fix:** always exclude the deploy SA from authoritative policies; apply org-level changes from a separate, higher-privilege stack with a different SA; `precondition` blocks that assert the deploy SA remains in the member list.

**B28. `google_project_service` for an API that has dependants: "Cannot disable service X as it has dependant services".**
- **Cause:** `disableDependentServices` defaults false.
- **Fix:** set it consciously, or `disableOnDestroy: false` (recommended: destroying stacks should not disable APIs).

### Assets

**B29. `TerraformAsset` for a Cloud Function zips and uploads, but the function does not redeploy when code changes.**
- **Cause:** the function references the object by name; the name does not change with content.
- **Fix:** name the object with the asset hash (`` `${asset.assetHash}.zip` ``) or reference `object.md5hash`/`detectMd5hash` in the function's `buildConfig.source.storageSource.object`; module [B04](../cdktf-gcp/src/modules/04-serverless-and-events/README.md) shows both.

**B30. Assets appear in `cdktf.out` but `terraform apply` from another machine fails with "no such file".**
- **Cause:** asset paths in `cdk.tf.json` are relative to `cdktf.out/stacks/<id>`; copying only `cdk.tf.json` (or the HCL) loses them.
- **Fix:** ship the whole stack directory as the CI artefact, or upload assets in the synth job and reference bucket objects.

### Aspects, testing, CLI and versions

**B31. An aspect that sets `labels` did nothing on some resources, or threw on a data source.**
- **Cause:** not every resource has `labels` (some have `userLabels`, `resourceLabels`, or none); data sources and providers are visited too.
- **Fix:** `if (node instanceof TerraformResource && 'labels' in node)` style checks, or a map of resource type → label attribute; skip `TerraformDataSource`/`TerraformProvider`. Module [B06](../cdktf-gcp/src/modules/06-aspects-labels-and-governance/README.md).

**B32. Aspects run on `cdktf synth` but not in a test using `stack.toTerraform()` directly.**
- **Cause:** `toTerraform()` does not invoke aspects; `Testing.synth(stack)` and `app.synth()` do (`Testing.synth` runs validations only with `runValidations = true`).
- **Fix:** use `Testing.synth(stack, true)` (this repo's convention) or `Testing.fullSynth`.

**B33. `toHaveResourceWithProperties` fails though the property is there.**
- **Cause:** with the jest adapter, top-level matching is `objectContaining` but nested objects/arrays must match exactly; block attributes render as arrays (`versioning: [{ enabled: true }]`) in JSON.
- **Fix:** match the rendered shape (`Testing.synth` output), nest `expect.objectContaining`/`expect.arrayContaining`, or parse the JSON and assert directly.

**B34. `toBeValidTerraform()` / `toPlanSuccessfully()` fail in CI with "terraform: command not found" or a provider download timeout.**
- **Cause:** they shell out to the binary and need network for `init`.
- **Fix:** gate them behind an env var (this repo), install Terraform/OpenTofu in the job, set `TERRAFORM_BINARY_NAME=tofu` if using OpenTofu, and warm `TF_PLUGIN_CACHE_DIR`.

**B35. `cdktf synth` prints nothing and `cdktf.out` is empty.**
- **Cause:** `app.synth()` was not called (it is explicit in CDKTF).
- **Fix:** end `main.ts` with `app.synth()`.

**B36. After `npm update`, `cdktf` and `cdktf-cli` differ by a minor: "The cdktf-cli version does not match the cdktf library version".**
- **Cause:** they must share a minor; provider bindings track the library minor too.
- **Fix:** pin `cdktf`, `cdktf-cli` and every `@cdktf/provider-*` together; with archived prebuilt packages, `cdktf` > 0.21.0 would require regenerating bindings with `cdktf get` — plan that migration before upgrading the core.

**B37. `cdktf get` takes minutes and the `.gen` folder is enormous; TypeScript builds crawl.**
- **Cause:** the Google provider has ~1,500 resources; generated bindings are large.
- **Fix:** `CDKTF_EXPERIMENTAL_PROVIDER_SCHEMA_CACHE_PATH` for repeated `get`s; import per-resource paths (`@cdktf/provider-google/lib/storage-bucket`), never the package barrel; `skipLibCheck: true`; `ts-node --transpile-only`/`tsx`; exclude `.gen` from lint.

**B38. `cdktf convert` output compiles but references `${...}` strings and untyped `TerraformResource`s.**
- **Cause:** the converter is literal and cannot type expressions it does not understand.
- **Fix:** treat it as a first draft; replace raw resources with binding classes, expressions with `Fn.*`/iterators; run `cdktf synth --hcl` and diff against the original HCL to prove equivalence before touching state.

**B39. `cdktf deploy` re-plans in CI and applies something different from the plan posted on the PR.**
- **Cause:** `cdktf deploy` always runs its own plan; the PR plan was advisory.
- **Fix:** for strict plan/apply equivalence, run Terraform directly in `cdktf.out/stacks/<id>` (`terraform plan -out plan.tfplan` as the artefact, `terraform apply plan.tfplan` in the apply job), with `cdktf synth` as the only CDKTF step. Module [B08](../cdktf-gcp/src/modules/08-cicd-and-workload-identity/README.md).

**B40. `S3Backend`/`GcsBackend` lacks a property the current Terraform supports (`use_lockfile`, new auth options).**
- **Cause:** the 0.21.0 typings predate Terraform 1.10+.
- **Fix:** `backend.addOverride('use_lockfile', true)`; the same trick works for any block CDKTF's typings do not know.
