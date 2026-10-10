# The Mastery Guide

> The theory that the 24 modules assume. Each chapter is keyed to a module number and treats AWS CDK (`aws-cdk-lib` 2.269.0, CLI 2.1141.0) and CDK for Terraform (`cdktf` 0.21.0, `@cdktf/provider-google` 16.12.1 → `hashicorp/google` 6.50.0) side by side. Where the two agree, that is the `constructs` substrate talking. Where they disagree, that is CloudFormation versus Terraform talking. Keep the two voices apart and most "CDK is weird" questions answer themselves.

Companion documents: [ROSETTA-STONE](ROSETTA-STONE.md) for one-line concept mappings, [GOTCHAS](GOTCHAS.md) for symptoms, [CHEATSHEET](CHEATSHEET.md) for commands, [MIGRATION](MIGRATION.md) for playbooks, [DECISION-MATRIX](DECISION-MATRIX.md) for "which one", [INTERVIEW-QA](INTERVIEW-QA.md) to test yourself, [MASTERY-CHECKLIST](MASTERY-CHECKLIST.md) to know when you are done. The [CURRICULUM](CURRICULUM.md) lists modules and pinned versions.

Dates in this document were checked against the npm registry on 2026-09-15. Anything marked *(unverified)* is a claim the author could not confirm from installed code or the registry; treat it as a pointer to check, not a fact.

---

## 0. Infrastructure as a program — what changes and what does not

Modules: [A00](../aws-cdk/src/modules/00-introduction/README.md) · [B00](../cdktf-gcp/src/modules/00-introduction/README.md)

Declarative IaC (HCL, CloudFormation YAML) is a *data* format with a small expression language bolted on. A CDK is a *program* whose only observable output is that same data format. That sentence contains everything that is better and everything that is dangerous about the approach.

What changes:

- **Abstraction becomes real.** A function that returns "a bucket configured our way" is an ordinary function. You can compose it, test it, publish it with semver, and type-check its inputs. HCL modules approximate this; they cannot express "if the caller passed a KMS key, also create a key policy statement on the key that references the bucket's role" without contortions, and they cannot expose methods (`bucket.grantRead(role)`). CloudFormation cannot express it at all.
- **Defaults become opinions with a code path.** The L2 `s3.Bucket` blocks public access, the `Vpc` construct creates a NAT gateway per AZ, `google_sql_database_instance` bindings do exactly what the provider schema says and nothing more. Knowing which layer adds which default is most of the job of reading a synthesized template.
- **Identity moves from a name you typed to a path the framework computed.** In HCL, `resource "google_storage_bucket" "main"` is the address `google_storage_bucket.main`; in CFN, `Resources.MainBucket` is the logical ID. In both CDKs, identity is derived from the construct path (chapter 1). Refactoring code can therefore change identity, and changing identity means replace-or-orphan. This is the single most expensive category of CDK incident.
- **The unit of review changes.** A PR diff of TypeScript is not a diff of infrastructure. Serious teams review both the code and the synthesized artefact diff (`cdk diff` / `terraform plan`), and CI must produce the latter.
- **Testing becomes possible before deployment.** You can assert on the rendered template or `cdk.tf.json` in milliseconds. This is not a substitute for a plan/change set, but it catches the class of mistakes a linter catches in application code.

What does not change:

- **The engine still owns reality.** CloudFormation still decides what is a replacement, still rolls back, still refuses to delete a non-empty bucket. Terraform still needs a state file, a lock, and a provider that knows how to diff a resource. A CDK gives you a better pen; the paper and the printer are unchanged. Every CDK limitation that feels arbitrary ("why can't I use the bucket name in an `if`?") is the printer's limitation surfacing in the pen.
- **You cannot branch on deploy-time values.** A token is a promise of a value that exists only after the engine runs. Neither CDK can evaluate `if (bucket.bucketName.startsWith('prod'))` because at synth time there is no name. HCL has the same constraint, but the syntax makes it obvious; TypeScript makes it look like it should work.
- **Blast radius is still governed by stacks/state files.** A program can create a thousand resources in one stack. The engine will treat that as one unit of failure.
- **The cost of getting names wrong is the same.** Physical names are still global (S3, GCS), still immutable (most of them), still subject to reuse delays.

One more thing that does *not* change and that people forget: the program runs on a laptop or a CI runner, with that machine's credentials, filesystem and clock. Anything nondeterministic in the program (a `Date.now()` in a tag, a random suffix generated in TypeScript rather than by the `random` provider) makes every synth a diff. Synthesis must be a pure function of the source tree plus committed context.

### How the two frameworks relate

| | AWS CDK | CDKTF |
|---|---|---|
| Owner | AWS. First-party, the recommended way to author CloudFormation. | HashiCorp (now IBM). Core library still published; prebuilt provider bindings were **archived on 2025-12-10** (the installed `@cdktf/provider-google` README says so verbatim). |
| Latest core release at time of writing | `aws-cdk-lib` 2.269.0 (2026-09-10); CLI 2.1141.0 (2026-09-09). Weekly-ish cadence. | `cdktf` 0.21.0 (2025-06-04). No release in the fifteen months since. |
| Substrate | `constructs` 10.x | `constructs` 10.x |
| Output | CloudFormation templates + asset manifests in `cdk.out/` (cloud assembly schema 54.x) | Terraform JSON (`cdk.tf.json`) or, with `--hcl`, HCL (`cdk.tf`) in `cdktf.out/stacks/<id>/` |
| Engine | CloudFormation (managed, server-side state) | Terraform or OpenTofu binary (client-side plan/apply, state file) |
| Abstraction layers | L1 (generated), L2 (hand-written), L3 (patterns) | Generated bindings only; no first-party L2 |
| Policy/testing | `assertions` module, `Validations` plugins, cdk-nag | `Testing` module + jest matchers; conftest/OPA/Sentinel on `cdk.tf.json` |

The CLI/library split matters for how you read version numbers. Until February 2025 `aws-cdk` (CLI) and `aws-cdk-lib` shared a version. CLI 2.1000.0 (2025-02-18) started an independent train; the CLI is backwards compatible with older libraries and refuses cloud assemblies whose schema version is newer than it understands ("please upgrade your CLI"). Pin both. In CDKTF, `cdktf` and `cdktf-cli` must share a minor, and each prebuilt provider major tracks one `cdktf` minor (`@cdktf/provider-google` 16.x → `cdktf` 0.21).

---

## 1. The construct tree

Modules: [A01](../aws-cdk/src/modules/01-constructs-and-tokens/README.md) · [B01](../cdktf-gcp/src/modules/01-providers-resources-and-tokens/README.md)

### 1.1 Scope, id, path

Both frameworks import `Construct` from the same `constructs` package. A construct is created with `(scope, id, props)`; `scope` is the parent, `id` must be unique among siblings, and `node.path` is the `/`-joined list of ids from the root. `node.findAll()` walks the subtree pre-order, `node.tryFindChild(id)` looks up a child, `node.defaultChild` is the child with id `Resource` or `Default`, `node.addDependency()` orders subtrees, `node.addValidation()` registers a validator, `node.setContext()/tryGetContext()` reads context, `node.addMetadata()` attaches metadata. This API is identical in both frameworks because it is the same code. This is why `shared/src/policy.ts` can define a `ConstructPolicy` with a `visit(node: IConstruct)` method and hand it to `Aspects.of(app).add(...)` in either framework: the `IAspect` interfaces are distinct TypeScript types but structurally identical.

What each framework adds to the substrate:

- AWS CDK: `App` (root, owns `outdir`), `Stage` (an isolated cloud assembly with its own env), `Stack` (renders its `CfnElement` descendants into a template), `CfnElement`/`CfnResource` (things with a logical ID). `Stack.of(construct)` finds the enclosing stack; `Stage.of()` the enclosing stage.
- CDKTF: `App` (root, owns `outdir`, `hclOutput`, `skipValidation`), `TerraformStack` (renders its `TerraformElement` descendants into one Terraform configuration with one backend), `TerraformElement` (resources, data sources, providers, variables, outputs, locals, backends). `TerraformStack.of(construct)` finds the stack. There is no `Stage`; environments are modelled by stack instances.

### 1.2 Logical IDs

Both frameworks derive the engine-facing identity from the path, and both use the same algorithm lineage (CDKTF forked it). Verified against the installed sources:

| | AWS CDK (`core/lib/private/uniqueid.js`) | CDKTF (`lib/private/unique.js`) |
|---|---|---|
| Input | Path components from the stack down to the `CfnElement`, ids `Default` removed | Path components from the stack down to the `TerraformElement`, ids `Default` removed |
| Single component | Used verbatim (non-alphanumerics stripped), if ≤ 255 chars | Used verbatim (chars outside `[A-Za-z0-9_-]` stripped), if ≤ 255 chars |
| Otherwise | `removeDupes(components)` minus `Resource`, non-alphanumerics stripped, joined with **no separator**, truncated to 240, plus 8 uppercase hex chars of MD5 of the full `/`-joined path | Same, but joined with `_`: `human_HASH` |
| Example | `M00-Hello/Artifacts/Resource` → `Artifacts82DD59A1` | `m00-hello/bucket` → `bucket`; `net/vpc/subnet` → `vpc_subnet_ABCD1234` |
| Override | `cfnResource.overrideLogicalId('X')`; `stack.renameLogicalId(old, new)`; subclass `Stack.allocateLogicalId()` | `element.overrideLogicalId('x')` / `resetOverrideLogicalId()`; subclass `TerraformStack.allocateLogicalId()` |
| Where it shows | `Resources.<LogicalId>` in the template, `aws:cdk:path` metadata | `resource.<type>.<logicalId>` in `cdk.tf.json`, plus `//metadata.path` (the construct path) in each block |

Consequences you must internalise:

- A top-level element (direct child of the stack) has a **human-only** ID with no hash. Renaming it, or moving it under a wrapper construct, changes the ID; CloudFormation then sees delete + create, Terraform sees destroy + create. Wrapping an existing resource in a new construct is a replacement unless you preserve the ID.
- `Resource` is hidden from the human part but included in the hash. `Default` is removed entirely, so `new Wrapper(this, 'Default')` is the idiom for a construct that should be identity-transparent. AWS CDK L2s use `Resource` for their L1 child, which is why `bucket.node.defaultChild` works.
- Both hash the path, not the properties. Changing a property never changes identity; changing the path always does. `cdk refactor`, `moved` blocks and `terraform state mv` exist to reconcile the two (chapter 10).
- CDKTF changed its scheme in 0.17 (the old scheme, deprecated since 0.15, computed components from the *app* root and stripped `-`/`_`). `MigrateIds` is an aspect shipped in `cdktf` that, for every `TerraformResource`, computes the old address and emits a `moved` block from it to the new one (and warns with a `terraform state mv` command for modules). It is a one-time migration aid: apply once, then remove it.

Predicting an ID by hand, both frameworks:

```ts
// AWS CDK — path M00-Hello/Artifacts/Resource
//   components after the stack: ['Artifacts', 'Resource']
//   human part: 'Artifacts' ('Resource' hidden)      hash: md5('Artifacts/Resource')[0:8].upper()
//   => 'Artifacts82DD59A1'
// CDKTF   — path net/Vpc/Subnet (Vpc and Subnet are constructs; the resource has id 'Default')
//   components: ['Vpc', 'Subnet']  ('Default' dropped entirely)
//   => 'Vpc_Subnet_' + md5('Vpc/Subnet')[0:8].upper()
// Keep the ID while restructuring code:
(bucket.node.defaultChild as s3.CfnBucket).overrideLogicalId('Artifacts82DD59A1'); // AWS CDK
subnet.overrideLogicalId('Vpc_Subnet_1A2B3C4D');                                    // CDKTF
```

The test that protects you is a snapshot of `Object.keys(template.Resources)` (CDK) or of the keys under `resource.<type>` in `Testing.synth()` (CDKTF), reviewed by a human when it changes.

### 1.3 L1 / L2 / L3 versus provider bindings

AWS CDK ships three layers in one package:

- **L1** (`Cfn*`): generated from the CloudFormation resource specification. Every property is a raw CloudFormation property; no defaults, no validation beyond types, `addPropertyOverride` for anything the schema does not know yet. One L1 = one template resource.
- **L2**: hand-written, opinionated. Secure defaults (`enforceSSL`, `blockPublicAccess`), helper methods (`grantRead`, `metricErrors`, `addEventNotification`, `connections.allowFrom`), interfaces (`IBucket`) with `fromXxxArn/Name/Attributes` importers so that code can accept either an owned or an imported resource. An L2 typically creates several L1s (a bucket plus its policy; a Lambda plus its role plus its log group under `@aws-cdk/aws-lambda:useCdkManagedLogGroup`).
- **L3** (patterns): several L2s wired for one use case (`ApplicationLoadBalancedFargateService`, `LambdaRestApi`). Fast to start, awkward to bend; production code often starts on an L3 and is rewritten to L2s once the exceptions accumulate.

CDKTF has one generated layer. `@cdktf/provider-google` is `cdktf get` output published as a jsii package: one class per resource (`StorageBucket`), one per data source (`DataGoogleProject`), one provider class (`GoogleProvider`), all mirroring the provider schema field-for-field. Nothing adds defaults, nothing grants, nothing validates beyond type. Why no L2?

1. Terraform's abstraction unit is the **module**, and HashiCorp's position was that modules (consumed via `TerraformHclModule` or generated bindings) are the L2. Modules are HCL, so they are opaque to your program: you cannot call a method on `terraform-google-modules/network`, only pass variables and read outputs.
2. An L2 layer must be written per provider and maintained against the provider's release cadence (the Google provider ships weekly). AWS funds that for CloudFormation; nobody funded it for the 4,000+ Terraform providers.
3. The product bet was "bring Terraform's ecosystem to programmers", not "build a better ecosystem". The ecosystem is the modules.

What fills the gap: your own constructs (module B05), community packages on Construct Hub (search for `cdktf`), and the [`terraform-google-modules`](https://github.com/terraform-google-modules) registry modules consumed through `TerraformHclModule` (typed via `cdktf get` when listed in `cdktf.json`). This repo's `shared/` package is the pattern: write your abstraction against `constructs` and make the leaf resources the only framework-specific code.

Now that prebuilt bindings are archived, the supported route is `cdktf provider add hashicorp/google --force-local` (or listing `hashicorp/google@~> 6.50` in `cdktf.json` `terraformProviders` and running `cdktf get`), which generates the same classes into `.gen/` at build time. The pinned `@cdktf/provider-google` 16.12.1 keeps working with `cdktf` 0.21.0; it will not work with any later `cdktf`.

### 1.4 Tokens, lazies and intrinsics

A **token** is a placeholder string/number/list that the framework substitutes at synthesis. Both frameworks encode them the same way (`${Token[TOKEN.42]}` inside strings; a magic negative number for numbers; a one-element magic list for lists) because both inherit the design from `constructs`-era CDK.

AWS CDK:

- `Token.isUnresolved(x)` — is this a token? Use before any string logic on stack-derived values (`stack.region`, `bucket.bucketName`).
- `Token.asString/asNumber/asList(resolvable)` — wrap an `IResolvable` in a typed token.
- `Lazy.string({ produce })`, `Lazy.number`, `Lazy.list`, `Lazy.any` — defer a value until synthesis; `produce` runs during the prepare phase's reference-resolution pass and again at render (see chapter 2), so it must be idempotent. The cached variants (`Lazy.string`) freeze the first result; `Lazy.uncachedString` re-runs.
- `Fn.*` — CloudFormation intrinsics returned as tokens: `Fn.join`, `Fn.select`, `Fn.split`, `Fn.sub`, `Fn.getAtt`, `Fn.ref`, `Fn.importValue`, `Fn.getStackOutput` (new in 2.254.0 for weak references; renders `Fn::GetStackOutput`), `Fn.conditionEquals/If/And/Or/Not`, `Fn.cidr`, `Fn.base64`, `Fn.findInMap`, `Fn.getAzs`, `Fn.toJsonString`, `Fn.length`.
- `CfnCondition`, `CfnParameter`, `CfnMapping` — template-level constructs for deploy-time branching. Use sparingly; the whole point of a CDK is to branch at synth time.
- `stack.resolve(x)` — force-resolve a token to its template form (tests use this to inspect intrinsics).

CDKTF:

- `Token.asString/asNumber/asList/asNumberList/asStringMap/asBooleanMap/asAnyMap(value)` — the same wrappers. You reach for them constantly because provider attributes are typed (`bucket.name` is `string`) but sometimes you have an `IResolvable` (from `Fn.*`, an iterator, `propertyAccess`) that must be passed where a `string` is expected. `Token.asString` exists because TypeScript types cannot represent "string at apply time".
- `Fn.*` — every Terraform built-in as a static method (`Fn.join`, `Fn.lookup`, `Fn.jsonencode`, `Fn.templatefile`, `Fn.tolist`, `Fn.element`, `Fn.plantimestamp`, `Fn.sensitive`, `Fn.nonsensitive`, ...), plus `Fn.conditional(cond, a, b)` for `? :`, `Fn.lookupNested`, and `Fn.rawString` to emit a string that must not be escaped. Functions added to Terraform after the generator ran (e.g. `templatestring`, `ephemeralasnull`, provider-defined `provider::google::name_from_id`) are not on `Fn`; the exported `call(name, args)` from `cdktf` renders any function name verbatim.
- `Op.*` — operators (`Op.eq`, `Op.and`, `Op.add`, ...) as expressions.
- `propertyAccess(target, ['a', 0, 'b'])` — `target.a[0].b` on an expression; `ref('google_project.main.id')` for a raw reference; `conditional`, `forExpression`.
- `TerraformIterator.fromList/fromMap/fromComplexList/fromResources/fromDataSources` plus `iterator.getString('attr')`, `.key`, `.value`, `.pluckProperty`, `.dynamic({...})` — `for_each` and `dynamic` blocks. Pass the iterator as `forEach` on a resource. `TerraformCount.of(n)` and `count.index` for `count`.
- `TerraformLocal`, `TerraformVariable` (with `validation`, `sensitive`, `nullable`), `TerraformOutput` (`sensitive`, `staticId`, `precondition`).
- `Lazy.stringValue/numberValue/listValue/anyValue({ produce })` — same deferral as CDK, but note the different method names.

The rules that follow from tokens, in both:

1. Never do string arithmetic on a token: `token.length`, `token.toUpperCase()`, `token.split('-')`, template literals that are then compared. Concatenation is fine (`` `prefix-${token}` `` becomes `Fn::Join` / `"${...}"`), comparison and slicing are not. `token.length` in AWS CDK returns the length of `${Token[TOKEN.42]}` (about 16), silently.
2. Never branch on a token with `if`. It is always truthy.
3. Never serialise a token with `JSON.stringify`; use `stack.toJsonString()` (CDK) or `Fn.jsonencode()` (CDKTF).
4. Never store a token in a `Map` key or `Set`; the placeholder is unique per token instance, not per value.
5. Do not compare two tokens for equality; `Token.compareStrings` returns `SAME`, `DIFFERENT` or `BOTH_UNRESOLVED`.

Side by side, the same three intents:

```ts
// 1. "The bucket's name, uppercased" — impossible at synth time in both; push it to the engine.
//    AWS CDK: there is no Fn::Upper; either accept lowercase or compute the name yourself and pass it in.
//    CDKTF:   Fn.upper(bucket.name)  -> "${upper(google_storage_bucket.bucket.name)}"

// 2. "The third AZ / the third zone"
const az = cdk.Fn.select(2, cdk.Fn.getAzs());                    // AWS CDK, deploy-time
const zone = Fn.element(zones.names, 2);                          // CDKTF, DataGoogleComputeZones.names is a token list

// 3. "One subnet per CIDR in a list that is only known at apply time"
//    AWS CDK: cannot loop over a token list. Either make the list a synth-time value (context/props),
//             or emit a fixed number of resources and let CloudFormation conditions turn them off.
//    CDKTF:   an iterator turns it into for_each, so the *engine* loops.
const it = TerraformIterator.fromList(cidrs);                     // cidrs may be a token
new ComputeSubnetwork(this, 'subnet', { forEach: it, ipCidrRange: it.value, name: `sn-${it.key}`, network: vpc.id, region });
```

A `Lazy` is the tool for "I know this at synth time, but only after all constructors have run" — a count of children, a list of ARNs collected by an aspect:

```ts
// AWS CDK
new cdk.CfnOutput(this, 'Count', { value: cdk.Lazy.string({ produce: () => String(this.node.findAll().length) }) });
// CDKTF
new TerraformOutput(this, 'count', { value: Lazy.stringValue({ produce: () => String(this.node.findAll().length) }) });
```

---

## 2. The synthesis lifecycle and what the engine does after

Modules: [A00](../aws-cdk/src/modules/00-introduction/README.md) · [B00](../cdktf-gcp/src/modules/00-introduction/README.md) · [A02](../aws-cdk/src/modules/02-stacks-environments-and-references/README.md) · [B02](../cdktf-gcp/src/modules/02-state-backends-and-environments/README.md)

### 2.1 Synthesis in AWS CDK

`cdk <command>` runs the `app` command from `cdk.json` with `CDK_OUTDIR`, `CDK_CONTEXT_JSON`, `CDK_DEFAULT_ACCOUNT/REGION` set, then reads the assembly. `app.synth()` (implicit via `autoSynth` when the CLI is driving) executes, in order as verified in module A00:

1. **construct** — your constructors run.
2. **prepare (aspects)** — `invokeAspects`: every aspect visits every node under the scope it was added to. Since 2.172.0 aspects have a `priority` (`AspectPriority.MUTATING` = 200, `DEFAULT` = 500, `READONLY` = 1000) and a stabilisation loop re-walks the tree if an aspect added nodes or aspects (`@aws-cdk/core:aspectStabilization`). With `@aws-cdk/core:aspectPrioritiesMutating` (2.189.1) the library's own aspects (Tags, RemovalPolicy helpers) run at MUTATING so yours run after them.
3. **prepare (references)** — `prepareApp`: every L1 is rendered once to discover tokens that point into other stacks; cross-stack references are materialised as Outputs/Exports (or `Fn::GetStackOutput`, or SSM-backed cross-region exports). `Lazy` producers run here for the first time.
4. **validate** — every `node.addValidation()` runs, pre-order; any message aborts.
5. **synthesize** — each stack's synthesizer writes `<stack>.template.json` and `<stack>.assets.json`; `tree.json`, `manifest.json`, the feature-flag report and `validation-report.json` follow; validation plugins (`Validations.of(app).addPlugins(...)`, which is how cdk-nag 3 attaches) run against the written templates.

The output, `cdk.out/`, is the **cloud assembly**: a self-contained deployment plan. `cdk deploy --app cdk.out` deploys it without re-running your program, which is the basis of the pipeline model (chapter 8): synth once, deploy the artefact many times.

### 2.2 Synthesis in CDKTF

`cdktf <command>` runs the `app` command from `cdktf.json` with `CDKTF_OUTDIR` (and `CDKTF_CONTEXT_JSON`, `CDKTF_TARGET_STACK_ID` for single-stack operations). `app.synth()` is **explicit**; forgetting it produces an empty `cdktf.out`. Order:

1. **construct**.
2. **prepare** — `invokeAspects` (no priorities in CDKTF; aspects run in registration order, parents before children); cross-stack references are resolved into outputs on the producer and `terraform_remote_state` data sources on the consumer (`registerOutgoingCrossStackReference` / `registerIncomingCrossStackReference`), and stack dependencies are recorded.
3. **validate** — `node.validate()` on every construct unless `App({ skipValidation: true })`; `Annotations.of(x).addError()` aborts, `addWarning` prints. Backend validation (`skipBackendValidation`) checks that a stack with cross-stack consumers has a non-local backend or that it is deliberate.
4. **synthesize** — `stack.toTerraform()` (or `toHclTerraform()` under `--hcl`/`SYNTH_HCL_OUTPUT`) writes `cdktf.out/stacks/<stackId>/cdk.tf.json` (or `cdk.tf`), plus a `manifest.json` listing every stack with its dependencies and `//metadata` annotations (construct path per element, stack trace when `stackTraces` is on). Assets are copied into `cdktf.out/stacks/<id>/assets/`.

`cdktf deploy` then runs `terraform init` (with provider lock), `terraform plan`, prompts, and `terraform apply` per stack in dependency order, honouring `--parallelism` for stacks and `--terraform-parallelism` for resources inside a stack. `--skip-synth` reuses `cdktf.out`; `--hcl` output is for humans and for HCL-only tooling (Sentinel, some scanners), not required by Terraform.

`cdktf.out/` anatomy (the counterpart of the `cdk.out` table in module A00):

| Path | Purpose |
|---|---|
| `manifest.json` | `version` (cdktf), and `stacks.<id>` with `name`, `constructPath`, `workingDirectory` (`stacks/<id>`), `synthesizedStackPath` (`stacks/<id>/cdk.tf.json` or `cdk.tf`), `annotations` (warnings/errors with construct paths), `dependencies` (stack ids). The CLI orders deploys from this. |
| `stacks/<id>/cdk.tf.json` | One Terraform root module: `terraform.required_providers` + `backend`, `provider`, `resource`, `data`, `variable`, `output`, `locals`, `module`, `moved`/`import` blocks, and a top-level `"//"` with `metadata` (version, stackName, backend) and `outputs` (construct path → output id). Every element also carries `"//": { "metadata": { "path": "<construct path>", "uniqueId": "<logical id>" } }`. |
| `stacks/<id>/cdk.tf` | Same content as HCL when synthesized with `--hcl` (or `App({ hclOutput: true })`, or `SYNTH_HCL_OUTPUT=true`). |
| `stacks/<id>/assets/<assetId>/<hash>/...` | `TerraformAsset` copies; the hash is the asset's content hash. |
| `stacks/<id>/.terraform/`, `.terraform.lock.hcl`, `terraform.tfstate` (local backend only) | Created by `terraform init`/`apply` when the CLI runs; commit the lock file if you want reproducible provider versions across machines (copy it out of `cdktf.out`, which is gitignored). |
| `stacks/<id>/plan` | `cdktf diff` writes a plan file here (binary); `terraform show -json` on it feeds conftest. |

Everything in `cdktf.out` is regenerated on every synth; the only durable artefacts are the state (in the backend) and the lock file (if you keep it).

### 2.3 What CloudFormation does after `cdk deploy`

1. Assets are published (`cdk-assets`): files to the bootstrap bucket keyed by content hash, images to the bootstrap ECR repo. Unchanged hashes skip upload.
2. The CLI assumes the **deploy role** and calls `CreateChangeSet` (the default `--method change-set`), passing the **CloudFormation execution role**. `--method direct` calls `UpdateStack` without a change set (faster, no preview, no `cdk diff --change-set` precision). `prepare-change-set` / `execute-change-set` split the two halves for approval workflows.
3. CloudFormation computes the diff against the **deployed template it stores** (its "state"), decides per resource whether the change is no-interruption, some-interruption or **replacement** (from the resource schema's `createOnlyProperties`), builds a dependency graph from `Ref`/`GetAtt`/`DependsOn`, and executes with as much parallelism as the graph allows.
4. On any resource failure, the stack **rolls back** to the previous template by default: every resource created is deleted, every updated resource is updated back. Rollback can itself fail (a bucket that gained objects, an ENI still attached), leaving `UPDATE_ROLLBACK_FAILED`; `cdk rollback` / `cdk rollback --orphan LogicalId` / `--force` and `ContinueUpdateRollback` are the tools. `cdk deploy --no-rollback` leaves a failed stack paused in `UPDATE_FAILED` so you can fix and retry (no replacements allowed in that mode); `--hotswap` bypasses CloudFormation entirely for Lambda code/ECS task definitions/Step Functions definitions and is for dev loops only, since it creates drift.
5. Stack **outputs** are updated; exports become visible to other stacks.

State is server-side and implicit: there is no file to corrupt, no lock to steal, no `-refresh`. The price is opacity (you cannot edit the state) and slowness (CloudFormation polls each resource's stabilisation; a CloudFront distribution or RDS instance can take 20+ minutes), and the fact that only resources CloudFormation knows about can be managed (Cloud Control API coverage has closed most gaps; custom resources cover the rest, chapter 10).

**Drift**: CloudFormation drift detection compares live configuration to the template for supported resource types; `cdk drift [--fail]` (stable in CLI 2.1141) runs it and reports. Drift is not corrected automatically; `cdk deploy --revert-drift` creates a drift-aware change set. Drift is CloudFormation's blind spot in a way it is not Terraform's: an update that does not touch a drifted property will not revert it.

### 2.4 What Terraform does after `cdktf deploy`

1. `terraform init` downloads providers into `.terraform/` (honouring `TF_PLUGIN_CACHE_DIR`, which `cdktf` sets automatically unless `CDKTF_DISABLE_PLUGIN_CACHE_ENV`), writes `.terraform.lock.hcl`, and configures the **backend** (local by default — a `terraform.tfstate` next to `cdk.tf.json`, which is unacceptable for anything shared; module B02 moves it to GCS).
2. `terraform plan`: acquires the state **lock** (GCS: a lock object created with a generation precondition; S3: DynamoDB table or, since Terraform 1.10, `use_lockfile`), **refreshes** every managed resource by reading it from the API (this is drift detection, every time, and it is why plans are slow on large states), diffs desired versus state+refresh, and writes a plan file.
3. `terraform apply` executes the plan with `-parallelism` (default 10) across independent resources, updating state after each resource. There is **no rollback**: a failure leaves state partially updated and every resource that was applied remains applied. You re-run; the plan is idempotent by design. Resources that were created but whose state write failed become **orphans** you must `import`.
4. Outputs are written to state; `cdktf output` reads them. Cross-stack consumers read them via `terraform_remote_state`, which requires the consumer's identity to be able to read the producer's state (the whole state, including secrets — see chapter 3).

**State** is a JSON document with a serial, a lineage UUID and one entry per resource instance including every attribute the provider returned (yes, including passwords for many resources). Protect it like a secrets store: versioned bucket, CMEK, uniform bucket-level access, no public, audit logs on, IAM narrowly scoped, `prevent_destroy` on the bucket. Recovery from corruption is a chapter-10 topic in [INTERVIEW-QA](INTERVIEW-QA.md).

**Drift** is detected on every plan by the refresh step; `cdktf diff --refresh-only` shows only drift; a scheduled `plan -detailed-exitcode` (exit 2 = changes) is the standard drift job (chapter 8). Terraform will revert drift on the next apply unless the attribute is in `ignore_changes` (`lifecycle.ignoreChanges` in CDKTF) — which is both the fix for "something else manages this field" and the source of "why didn't Terraform fix it".

### 2.5 The comparison that matters

| | CloudFormation | Terraform |
|---|---|---|
| State | Managed, server-side, implicit | A file you own and can corrupt |
| Preview | Change set (can miss replacement-on-update for some types) | Plan (accurate, includes refresh) |
| Failure | Automatic rollback (or paused with `--no-rollback`) | Stop; partial apply persists; re-run |
| Locking | Per-stack, implicit | Per state file, explicit backend feature |
| Drift | On demand, per stack, supported types only | Every plan, every resource |
| Parallelism | Engine-decided | `-parallelism`, default 10 |
| Cross-unit references | Exports (strong) / `Fn::GetStackOutput` (weak) / SSM | `terraform_remote_state` / data sources |
| Coverage | Resource types CloudFormation registry knows | Whatever a provider exists for |
| Timing | Waits for resource stabilisation; slow | Provider-defined waits; usually faster |

---

## 3. Stacks, environments and references

Modules: [A02](../aws-cdk/src/modules/02-stacks-environments-and-references/README.md) · [B02](../cdktf-gcp/src/modules/02-state-backends-and-environments/README.md)

### 3.1 What a stack is, in each

An AWS CDK `Stack` is one CloudFormation stack: one template, one unit of deploy/rollback, ≤ 500 resources (soft-ish; templates ≤ 1 MB via the bootstrap bucket), one target `env: { account, region }`. A `NestedStack` is a stack whose template is uploaded as an asset and referenced by an `AWS::CloudFormation::Stack` resource in its parent; the parent owns it, it counts as one resource in the parent, its parameters/outputs are wired automatically, and it rolls back with the parent. Use nested stacks to escape the 500-resource limit while keeping one deploy unit; use separate stacks to get independent lifecycles.

A CDKTF `TerraformStack` is one Terraform root module with one backend, therefore one state file, one lock, one `plan`/`apply`. It has no resource limit but a practical one: plan time scales with resource count because of refresh. There is no nested stack; a Terraform **module** (`TerraformHclModule`, or a generated binding from `cdktf.json` `terraformModules`) lives *inside* a stack's state, so it is closer to an AWS CDK *construct* than to a nested stack. The split between stacks in CDKTF is a split of state, which is the blast-radius decision.

### 3.2 Environment-agnostic versus explicit

AWS CDK stacks can omit `env`. Then `stack.account`/`region` are tokens (`AWS::AccountId`/`AWS::Region`), the manifest says `aws://unknown-account/unknown-region`, and the CLI deploys wherever its credentials point. This is convenient for samples and wrong for anything with lookups (`Vpc.fromLookup`, `HostedZone.fromLookup`, `StringParameter.valueFromLookup` all require a concrete env), anything with `crossRegionReferences`, anything that needs `Stack.of(this).availabilityZones` to be real (it returns two dummy AZs when agnostic), and any pipeline. Production rule: **always pass `env`**, sourced from `CDK_DEFAULT_ACCOUNT/REGION` only for developer sandboxes and from the environment model otherwise (`shared/src/environment.ts` plus a per-tier account map).

CDKTF has no agnostic mode. A `GoogleProvider` block sets `project`/`region`/`zone` defaults; every resource may override `project`. The equivalent of an explicit env is a stack that hard-codes (from config) its provider block and backend key. The equivalent of agnostic is reading `GOOGLE_PROJECT`/`CLOUDSDK_CORE_PROJECT` from the environment at synth time, which is the same footgun as agnostic CDK stacks: the synthesized artefact depends on who ran it.

### 3.3 Cross-stack references and the deadlocks they create

AWS CDK: when a token from stack A is used in stack B, the framework (in the prepare phase) adds an `Output` with an `Export` to A and an `Fn::ImportValue` to B, and records B → A as a dependency. This is the **strong** reference. CloudFormation enforces it: A cannot delete or change the exported value while B imports it. The classic deadlock: you stop using the value in B, deploy — CDK removes the export from A *and* the import from B in the same synth; deploying A first fails ("export in use by B"), deploying B first works. The fix is `stackA.exportValue(resource.attr)` to keep the export alive for one deployment, deploy both, then remove the `exportValue` call. `exportStringListValue` is the list variant.

Since 2.254.0 (2026-05-13) there is a **weak** reference mode via the feature flag `@aws-cdk/core:defaultCrossStackReferences` = `"weak"` (set in this repo's `cdk.json`), which renders `Fn::GetStackOutput` in the consumer against a plain Output in the producer. No export, no deadlock; the producer can be deleted or changed while consumers exist, and consumers then fail at their next update or at runtime until fixed. The flag is read from the **consumer's** context; `"both"` is the transitional state for migrating strong → weak (deploy with `both`, then with `weak`); weak → strong is a single deploy. Per-reference control: `CrossStackReferences.of(scope).produce(strength)` / `.consume(strength)` and `Stack.consumeReference(token, ReferenceStrength.WEAK)`. This is new enough that you should expect tooling (change-set diffs, third-party linters) to lag it *(the CloudFormation launch date of `Fn::GetStackOutput` itself was not verified by the author)*.

Cross-region references (`crossRegionReferences: true` on both stacks) use a pair of custom resources: an ExportWriter in the producer region writes to SSM parameters in the consumer region; an ExportReader reads them. It is a Lambda-backed custom resource, so it needs bootstrap ≥ 8, adds a few minutes, and cannot be used from an agnostic stack.

The decoupled alternative for both clouds is a **parameter store**: the producer writes SSM `StringParameter` (CDK) or a Secret Manager / Runtime Config / GCS object (GCP); the consumer reads with `valueForStringParameter` (deploy-time `AWS::SSM::Parameter::Value` parameter, no dependency recorded) or `valueFromLookup` (synth-time, cached in `cdk.context.json`). You give up ordering enforcement and gain independent lifecycles; document the contract.

CDKTF: a reference from stack A into stack B's resource attribute makes CDKTF add a `TerraformOutput` to A (named `cross-stack-output-<path>`) and a `DataTerraformRemoteState<Backend>` to B pointing at A's backend config, and records the dependency so `cdktf deploy` orders them and refuses to deploy B alone without `--ignore-missing-stack-dependencies`. Properties of this design:

- It requires A to have a **remote** backend that B can read (a local backend "works" only on one machine); the `skipBackendValidation` check exists to catch it.
- B reads **A's entire state**, so B's deploy identity can read every secret in A's state. Terraform ≥ 1.x cannot scope `terraform_remote_state` to one output. Sensitive estates use an intermediary (Secret Manager, a data source on the real resource, or `google_*` data sources by name) instead of remote state.
- There is no deadlock: Terraform does not know or care that B reads A's outputs. Deleting the output in A and deploying A first makes B's next plan fail with "unsupported attribute" until B is updated. It is the weak-reference semantics by default, and the ordering discipline is yours.
- Renaming stack A changes the remote-state key; every consumer breaks until re-pointed. Stack IDs are API.

The same wiring in both, and what it renders to:

```ts
// AWS CDK — strong reference (default without the flag)
const net = new NetworkStack(app, 'Net', { env });
const svc = new ServiceStack(app, 'Svc', { env, vpc: net.vpc });      // uses net.vpc.vpcId inside
// Net template:  Outputs.ExportsOutputRefVpc8378EB38...: { Value: {Ref: Vpc...}, Export: { Name: 'Net:ExportsOutputRefVpc...' } }
// Svc template:  { "Fn::ImportValue": "Net:ExportsOutputRefVpc..." }     + manifest dependency Svc -> Net
// With "@aws-cdk/core:defaultCrossStackReferences": "weak" in cdk.json (this repo):
// Svc template:  { "Fn::GetStackOutput": ["Net", "ExportsOutputRefVpc..."] }   and Net has a plain Output
// Un-wiring safely (strong mode): keep the export alive for one deploy
net.exportValue(net.vpc.vpcId);  // deploy Net + Svc, then delete this line and the usage together

// CDKTF — always remote_state
const net = new NetworkStack(app, 'net');           // has new GcsBackend(this, { bucket, prefix: 'net' })
const svc = new ServiceStack(app, 'svc', { network: net.vpc });   // uses net.vpc.id inside
// net/cdk.tf.json:  output.cross-stack-output-google_compute_networkvpcid = { value: "${google_compute_network.vpc.id}", sensitive: true }
// svc/cdk.tf.json:  data.terraform_remote_state.cross-stack-reference-input-net = { backend: "gcs", config: { bucket, prefix: 'net' } }
//                   ... "${data.terraform_remote_state.cross-stack-reference-input-net.outputs.cross-stack-output-google_compute_networkvpcid}"
// manifest.json:    stacks.svc.dependencies = ["net"]  -> cdktf deploy '*' orders them; cdktf deploy svc alone refuses without --ignore-missing-stack-dependencies
```

### 3.4 Context lookups versus data sources

AWS CDK **context providers** (`Vpc.fromLookup`, `HostedZone.fromLookup`, `Ami` lookups, `StringParameter.valueFromLookup`, `KeyLookup`, `SecurityGroup.fromLookupByName`, ...) run *during synthesis* on the developer's/CI's credentials via the bootstrap **lookup role**, and cache the answer in `cdk.context.json`. That file must be committed: the pipeline then synthesizes deterministically without lookups (`cdk synth --lookups=false` in CI is the guard). Stale cache is the classic failure ("the VPC was recreated but CDK still uses the old subnet IDs"): `cdk context --reset KEY` or `--clear`. Lookups fail in an env-agnostic stack.

CDKTF **data sources** (`DataGoogleProject`, `DataGoogleComputeNetwork`, `DataGoogleSecretManagerSecretVersion`, ...) are Terraform data blocks: resolved at *plan* time by the engine, never cached in the repo, always fresh, and their outputs are tokens. There is no synth-time lookup in CDKTF; the program cannot branch on a data source's value. If you need a synth-time value (the list of regions to loop over), fetch it outside the app (a script that writes JSON that the app reads, checked in like `cdk.context.json`) so synth stays pure. `App({ context })` and `CDKTF_CONTEXT_JSON` are the equivalents of CDK context for hand-supplied values.

### 3.5 Stack splitting heuristics (both)

Split by **rate of change and blast radius**, not by service. Typical layering: network/foundation (rarely changes, wide blast radius) → data (stateful, retain policies, slow) → compute/app (changes daily) → edge/DNS. Keep stateful resources in a stack that never has to be destroyed to fix a compute problem. One stack per environment per layer; never one stack containing two environments. In CDKTF this also maps to one state file per layer, which limits how much a stolen state-reader identity can see.

---

## 4. Assets and bundling

Modules: [A04](../aws-cdk/src/modules/04-serverless-and-events/README.md) · [B04](../cdktf-gcp/src/modules/04-serverless-and-events/README.md)

An asset is a local file or directory that must exist in the cloud before the template/config that references it can be applied.

AWS CDK: `aws-s3-assets.Asset`, `lambda.Code.fromAsset`, `NodejsFunction` (esbuild bundling: local `esbuild` binary if present, Docker otherwise), `DockerImageAsset` / `ContainerImage.fromAsset`, `s3-deployment.BucketDeployment`. During synth each asset is **staged** into `cdk.out/asset.<hash>` (or `.zip`) where `<hash>` is by default the SHA-256 of the *source* (`AssetHashType.SOURCE`), or of the bundling *output* (`OUTPUT`), or a `CUSTOM` hash you supply. The stack's `.assets.json` lists each asset with its destination (`cdk-<qualifier>-assets-<acct>-<region>` bucket / `cdk-<qualifier>-container-assets-...` ECR repo) and the publishing role to assume. `cdk deploy` runs `cdk-assets` to publish before `CreateChangeSet`; `cdk publish-assets` does only that; `--asset-parallelism` and `--asset-prebuild` control ordering. In the template the reference is `{S3Bucket, S3Key}` or an image URI with the hash in it, so **an unchanged asset is a no-op deploy and a changed asset is an update of the referencing resource**. Bundling runs in Docker unless the construct supports `local: ILocalBundling` (`tryBundle`); CI runners therefore need Docker or a local bundler. `bundlingFileAccess: VOLUME_COPY` exists for Docker-in-Docker runners where bind mounts do not work. Old assets accumulate in the bootstrap bucket; `cdk gc --unstable=gc` (tag-then-delete with buffer days) cleans them.

Why bootstrap is required for assets: the publishing roles and the bucket/repo are created by `cdk bootstrap`, the template references `BootstrapVersion` (SSM) via a `Rules` assertion, and the deploy role must be allowed to read the bucket. Bootstrap version 32 ships with CLI 2.1141.0; `cdk import` needs ≥ 12, `cdk rollback` ≥ 23, lookups ≥ 8, the default synthesizer ≥ 6.

CDKTF: `TerraformAsset(scope, id, { path, type: AssetType.FILE | DIRECTORY | ARCHIVE, assetHash? })`. During synth the file/directory is copied (or zipped, for `ARCHIVE`) into `cdktf.out/stacks/<id>/assets/<id>/<hash>/...`; `asset.path` is the relative path from the stack directory, `asset.fileName` the file name, `asset.assetHash` the hash. Nothing is uploaded by CDKTF: you wire the asset into a resource that uploads it (`StorageBucketObject { source: asset.path }` for a Cloud Functions gen2 zip, `archive_file` data source if you want Terraform to zip). Terraform re-uploads when the object's `source`/`detect_md5hash` changes, and the function must reference the object's `md5hash` or name to be redeployed. There is no bootstrap: the "asset bucket" is just a bucket you create, which is simpler and less safe (no publishing role separation). Docker images are not assets in CDKTF; build and push them in CI (Cloud Build, GHA) and pass the digest as a variable, or use the `docker`/`kreuzwerker` provider.

---

## 5. Custom constructs and libraries

Modules: [A05](../aws-cdk/src/modules/05-custom-constructs/README.md) · [B05](../cdktf-gcp/src/modules/05-constructs-and-modules/README.md)

### 5.1 API design conventions (both)

The AWS CDK design guidelines are the de facto standard for CDKTF constructs too, since jsii imposes them:

- Constructor `(scope: Construct, id: string, props: XxxProps)`; `props` is an interface of `readonly` fields; required props first in docs; every optional prop has a documented `@default`.
- Never take primitive strings where a typed object exists (`Duration`, `Size`, an `IBucket`). Never return `undefined` where a token would do.
- Expose an `IXxx` interface with the attributes consumers need (`bucketArn`, `bucketName`) plus behaviours (`grantRead`), an abstract `XxxBase` implementing behaviours in terms of the interface, and `static fromXxxAttributes/Arn/Name()` importers returning an `IXxx` so downstream code works with owned and imported resources alike. Prefer `grant*`/`metric*`/`connections` methods to props for cross-resource wiring.
- Validate in the constructor and throw (or `Annotations.of(this).addError`) with the construct path; do not validate tokens (`Token.isUnresolved` guard).
- Do not expose the child L1/provider resource as a required part of the API, but do keep `node.defaultChild` working (id `Resource`), because escape hatches depend on it.
- Enum-like classes (`InstanceType.of(...)`, `Runtime.NODEJS_22_X`) over string unions, because jsii cannot express unions to Python/Java/C#/Go.
- Behaviour changes are breaking; prop additions are not; default changes are gated by a feature flag (AWS CDK) or a major version (everyone else).

In CDKTF constructs additionally: accept a `provider?: TerraformProvider` prop and pass it to every resource so callers can alias (`google-beta`, another project/region); accept and propagate `dependsOn`; return the created resources as `readonly` fields so callers can `importFrom`/`moveTo` them; keep `count`/`forEach` out of the construct's API unless you commit to iterator types.

### 5.2 jsii

Both frameworks and all construct libraries meant for more than TypeScript are compiled by **jsii**: TypeScript in, a language-neutral assembly plus generated Python/Java/.NET/Go packages out (`jsii-pacmak`). The constraints are real even if you only ship TypeScript, because `aws-cdk-lib` and `cdktf` themselves were compiled with them: no union types in exported APIs except string/number unions in limited spots, no generics, no arrow-function properties, no `Promise`, interfaces named `IXxx` for behavioural interfaces and `XxxProps` for structs, no overloading, `readonly` structs, no `Map`/`Set` (use `{ [key: string]: T }`), no `undefined` in return unions beyond `T | undefined`. If your TypeScript-only library ignores these, you can still consume `aws-cdk-lib`; you just cannot publish for other languages and you cannot appear on Construct Hub with multi-language support. jsii also pins the TypeScript compiler (jsii 5.9 ↔ TS 5.9); TypeScript 7 (the Go port) is not yet supported by any jsii release *(unverified beyond the CURRICULUM note)*.

### 5.3 projen and Construct Hub

**projen** generates and owns the project scaffolding (`package.json`, `tsconfig`, jest config, GitHub workflows, release automation) from a `.projenrc.ts`; `AwsCdkConstructLibrary` and `ConstructLibraryCdktf` (project types) encode the conventions above, including `peerDependencies` on `aws-cdk-lib`/`cdktf`/`constructs` (never `dependencies` — two copies of `aws-cdk-lib` in one app break `instanceof` and duplicate feature-flag state). **Construct Hub** (constructs.dev) indexes public npm packages that carry a jsii assembly and the `cdk`/`cdktf` keywords; for internal libraries, host a private Construct Hub or just a private registry.

### 5.4 Versioning constructs

Semver on the construct library, with these framework-specific rules: bump `peerDependencies` minimums only in a minor or major; treat any change that alters a synthesized template for an unchanged caller as breaking unless it is behind a flag or the change is non-replacing; publish a changelog that lists **logical ID impact** for each change. Chapter 11 covers rolling breaking changes across many stacks.

---

## 6. Governance

Modules: [A06](../aws-cdk/src/modules/06-aspects-tags-and-governance/README.md) · [B06](../cdktf-gcp/src/modules/06-aspects-labels-and-governance/README.md)

Four layers, from cheapest to most authoritative:

1. **In-program (aspects, validations).** Runs at synth, on the developer's laptop and in CI. Fast, precise (it sees the construct tree, not just the template), and bypassable by anyone who can edit the code. Aspects in both frameworks are `{ visit(node) }` registered with `Aspects.of(scope).add(aspect)`; AWS CDK adds `{ priority }` and the stabilisation loop; CDKTF runs them in order once. Mutating aspects (add tags/labels, set `deletionProtection`, set `removalPolicy`) should run before read-only ones (assert every bucket has CMEK); in AWS CDK use `AspectPriority.MUTATING`/`READONLY`, in CDKTF register them in that order. Read-only aspects report via `Annotations.of(node).addError(...)` (fails synth in both) or `Validations.of(node).addWarning(id, msg)` (AWS CDK, acknowledgeable). `Tags.of(scope).add(k, v, { includeResourceTypes, excludeResourceTypes, priority })` is itself an aspect; with `@aws-cdk/core:explicitStackTags` stack-level tags must be set via `StackProps.tags`, not via `Tags.of(stack)`, to avoid double application. In CDKTF the label aspect is yours to write: visit every `TerraformResource`, check the schema has `labels`, merge; module B06 does this with `normaliseLabelKey/Value` from `shared/`.
2. **Template/config linters.** AWS: **cdk-nag** 3.0.x, which since 3.0.0 (2026-06-12) is a `Validations` plugin: `Validations.of(app).addPlugins(new AwsSolutionsChecks(app))`, suppress with `Validations.of(construct).acknowledge({ id: 'AwsSolutions-S1', reason })`, per-finding IDs like `AwsSolutions-IAM5[Action::s3:*]`, findings go to `validation-report.json`, and `writeSuppressionsToCloudFormation` keeps the v2-style `cdk_nag` metadata for auditors. Packs: AwsSolutions, HIPAA, NIST 800-53 r4/r5, PCI DSS 3.2.1, Serverless. Also `cfn-lint`, `cfn_nag`, `checkov` on the template. GCP: **conftest** (OPA/Rego) on `cdk.tf.json` (it is JSON; no HCL parsing needed) or on the plan JSON (`terraform show -json plan.out`, which sees computed values); **Sentinel** if on HCP Terraform; `checkov`/`tfsec`/`trivy` on HCL if you synth `--hcl`; **OPA Gatekeeper / Config Validator** policy libraries for GCP have Rego rules you can reuse against plan JSON.
3. **Engine-side hooks.** AWS: **CloudFormation Hooks** (Lambda- or Guard-based, evaluated by CloudFormation before create/update, can block) and **Guard** rules; these catch what any tool — CDK, console, Terraform — sends to CloudFormation. GCP: nothing equivalent inside Terraform; HCP Terraform run tasks and Sentinel are the closest, and they only see Terraform runs.
4. **Organisation guardrails.** AWS: SCPs (deny at the org/OU level regardless of IAM), **permission boundaries** (a managed policy that caps what roles created by the deploy role can be granted — `cdk bootstrap --custom-permissions-boundary` or `PermissionsBoundary.fromName()` on a `Stage`/`Stack` so CDK attaches it to every role it creates; this is how you let teams create IAM roles without letting them escalate), Config rules for detective control. GCP: **organisation policies** (`OrgPolicyPolicy` constraints such as `constraints/iam.disableServiceAccountKeyCreation`, `constraints/compute.vmExternalIpAccess`, `constraints/storage.uniformBucketLevelAccess`, `constraints/gcp.resourceLocations`), folder-level IAM deny policies, VPC Service Controls, and Security Command Center for detective control. The GCP analogue of a permission boundary is the combination of org policies plus custom roles plus "who can `setIamPolicy`" — there is no per-principal cap on grantable permissions.

Rule of thumb: the in-program layer is for developer feedback, layers 3–4 are for enforcement. A control that exists only as an aspect is a suggestion.

The same rule ("stateful things must not be deletable in prod") as an aspect in each framework, plus the shared walker:

```ts
// AWS CDK — mutating, so it runs before read-only checks
class RetainStateful implements cdk.IAspect {
  visit(node: IConstruct) {
    if (node instanceof cdk.CfnResource && /^AWS::(S3::Bucket|DynamoDB::(Global)?Table|RDS::DB)/.test(node.cfnResourceType)) {
      node.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);            // sets DeletionPolicy + UpdateReplacePolicy
    }
  }
}
cdk.Aspects.of(prodStage).add(new RetainStateful(), { priority: cdk.AspectPriority.MUTATING });
cdk.Aspects.of(prodStage).add(new RequireCmek(), { priority: cdk.AspectPriority.READONLY }); // Annotations.of(n).addError(...)

// CDKTF — no priorities; register mutators first
class ProtectStateful implements IAspect {
  visit(node: IConstruct) {
    if (node instanceof SqlDatabaseInstance) node.deletionProtection = true;
    if (node instanceof StorageBucket) node.addOverride('lifecycle.prevent_destroy', true);
  }
}
Aspects.of(prodStack).add(new ProtectStateful());
Aspects.of(prodStack).add(new RequireCmek());          // Annotations.of(node).addError(...) fails synth

// Shared — framework-agnostic, from @cdk-mastery/shared; the same object works in both Aspects.of(...).add()
const policy = new ConstructPolicy([PascalCaseIds, maxDepthRule(8)]);
cdk.Aspects.of(app).add(policy);   // or Aspects.of(tfApp).add(policy)
app.synth(); policy.throwIfViolated();
```

cdk-nag 3 wiring and a justified suppression, for reference:

```ts
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
Validations.of(logBucket).acknowledge({ id: 'AwsSolutions-S1', reason: 'This is the access-log bucket itself.' });
```

---

## 7. Testing philosophy for IaC

Modules: [A07](../aws-cdk/src/modules/07-testing/README.md) · [B07](../cdktf-gcp/src/modules/07-testing/README.md)

The pyramid, with what each level can prove:

| Level | AWS CDK | CDKTF | Proves | Cost |
|---|---|---|---|---|
| Unit: construct in isolation | `Template.fromStack(new Stack(new App(), 'T'))` after instantiating the construct in a throwaway stack; `hasResourceProperties`, `resourceCountIs`, `Match.objectLike/arrayWith/absent/anyValue/stringLikeRegexp/serializedJson`, `Capture`, `Annotations.fromStack(stack).hasError(path, msg)` | `Testing.synthScope(scope => new MyConstruct(scope, 'x', ...))` or `Testing.synth(stack)`; `expect(json).toHaveResourceWithProperties(StorageBucket, { ... })`, `toHaveDataSource`, `toHaveProvider`; `Testing.renderConstructTree` | The construct emits what you intend, defaults hold, validation rejects bad props | ms |
| Unit: stack | Same API on the real stack class; `Template.fromStack(stack)` synthesizes only that stack | `Testing.synth(stack, true)` (second arg runs validations) | Wiring between constructs, cross-construct grants | ms–s |
| Snapshot | `expect(template.toJSON()).toMatchSnapshot()` | `expect(Testing.synth(stack)).toMatchSnapshot()` | Nothing changed that you did not intend; forces a diff review | ms; brittle |
| Aspect/policy | Apply the aspect to a test stack, assert annotations/properties | Same; `ConstructPolicy.walk(root)` from `shared/` runs without the framework | Governance rules do what the doc says | ms |
| Synthesis validity | `cdk synth` in CI; `Validations` plugins; cdk-nag | `toBeValidTerraform()` (runs `terraform init -backend=false` + `validate`; needs the binary — gated in this repo) | The engine accepts the artefact | s–min |
| Plan | `cdk diff --change-set` against a real account | `toPlanSuccessfully()` (runs `terraform plan`; needs credentials); `cdktf diff` | The engine can compute a change; catches IAM/API/quota issues before apply | min |
| Integration | `@aws-cdk/integ-tests-alpha` / `integ-runner` deploys, asserts (API calls), destroys; or your own ephemeral account | Deploy an ephemeral stack (unique suffix from the `random` provider) in a sandbox project, run checks, destroy (`terratest` is the Go-world equivalent) | It actually works | min–h, money |

Opinions:

- **Snapshot tests are a change detector, not a test.** Use one per stack to force review of every template change in PRs, and accept that every intentional change requires updating it. Do not use them for constructs in a library, where consumers expect stability of *behaviour*, not of *bytes*. Strip volatile values (asset hashes: use a custom serializer or `Match.anyValue()` in a targeted assertion instead).
- **Assert on properties, not on logical IDs**, unless the test's purpose is ID stability (then it is the most important test in the library; see chapter 11).
- Test the **negative path** of validation (`expect(() => new X(...)).toThrow(/must be/)`) and of aspects (`Annotations.fromStack(stack).hasError('*', Match.stringLikeRegexp('CMEK'))`).
- Test constructs inside a **`Stage`** in AWS CDK when they behave differently per environment (`Stage` gives you a real env and `cdk.out` layout). CDKTF: instantiate the stack class with the environment tier from `shared/` and test both `dev` and `prod` variants.
- Tests must not need credentials, Docker or the Terraform binary to run; gate the ones that do behind an env var (this repo: `toBeValidTerraform` is gated). Otherwise `npm test` fails on a laptop and people stop running it.
- `cdk diff`/`cdktf diff` on every PR is a test. It is the only one that sees the deployed side.

The two assertion dialects for one intent ("every bucket is encrypted with a customer key and cannot be public"):

```ts
// AWS CDK
const template = Template.fromStack(stack);
template.allResourcesProperties('AWS::S3::Bucket', {
  BucketEncryption: { ServerSideEncryptionConfiguration: Match.arrayWith([
    Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: Match.anyValue() } }) ]) },
  PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }),
});
const keyArn = new Capture();
template.hasResourceProperties('AWS::S3::Bucket', { BucketEncryption: Match.objectLike({
  ServerSideEncryptionConfiguration: [ { ServerSideEncryptionByDefault: { KMSMasterKeyID: keyArn } } ] }) });
expect(keyArn.asObject()).toEqual({ 'Fn::GetAtt': [Match.stringLikeRegexp('Key.*'), 'Arn'] }); // or stack.resolve(...)
Annotations.fromStack(stack).hasNoError('*', Match.anyValue());

// CDKTF
const synthesized = Testing.synth(stack);
expect(synthesized).toHaveResourceWithProperties(StorageBucket, {
  uniform_bucket_level_access: true,
  public_access_prevention: 'enforced',
  encryption: [{ default_kms_key_name: expect.stringMatching(/projects\/.+\/cryptoKeys\/.+|\$\{google_kms_crypto_key\..+\}/) }],
});
expect(synthesized).not.toHaveResourceWithProperties(StorageBucketIamMember, { member: 'allUsers' });
// "all buckets" has no matcher: parse and loop
for (const b of Object.values(JSON.parse(synthesized).resource.google_storage_bucket ?? {})) expect((b as any).uniform_bucket_level_access).toBe(true);
```

Note the asymmetry: CDKTF's jest matchers (enabled by `import 'cdktf/lib/testing/adapters/jest'`, this repo's `test/setup.ts`) take the construct class and snake_case property names as rendered, and evaluate `expect.objectContaining(props)` — a top-level subset, with nested objects/arrays compared exactly unless you nest `expect.objectContaining`/`expect.arrayContaining`/`expect.stringMatching` yourself. The framework-neutral `Testing.toHaveResourceWithProperties(json, Class, props)` does a deep subset match tolerant of camel/snake case instead. AWS CDK matchers take the CloudFormation type string and PascalCase properties; `hasResourceProperties` wraps your pattern in `Match.objectLike`, which is partial for objects *at every depth* but requires arrays to match element-for-element in full length — use `Match.arrayWith` for "contains", `Match.exact` to opt out of partial matching, `Match.absent()` to assert a key is missing.

---

## 8. Delivery

Modules: [A08](../aws-cdk/src/modules/08-pipelines-and-cicd/README.md) · [B08](../cdktf-gcp/src/modules/08-cicd-and-workload-identity/README.md)

### 8.1 Self-mutating CDK pipelines

`aws-cdk-lib/pipelines.CodePipeline` is a construct that deploys a CodePipeline whose first stages are: source → **synth** (a CodeBuild running `npx cdk synth`, producing `cdk.out`) → **self-mutate** (a CodeBuild running `cdk deploy` on the pipeline stack itself, so a change to the pipeline definition takes effect before the next stages run; `selfMutation: false` disables) → optional asset publishing stages → then `addStage(new MyStage(...))` / `addWave()` with `pre`/`post` steps (`ManualApprovalStep`, `ShellStep`, `CodeBuildStep`) and `stackSteps` for per-stack hooks. Key properties: `crossAccountKeys` (KMS keys for cross-account artefact buckets; costs money, required for cross-account stages), `dockerEnabledForSelfMutation`/`dockerEnabledForSynth`, `useChangeSets` (default true — two actions per stack; false is faster), `pipelineType` V2 (the default under `@aws-cdk/aws-codepipeline:defaultPipelineTypeToV2`), `codeBuildDefaults` for the build environment (use it to pin the Node version and to attach a VPC when bundling needs private registries). It requires every target env to be bootstrapped with `--trust <pipeline-account>` and needs the pipeline account bootstrapped too. The model: synth once at the head, deploy the same assembly everywhere; a stage failing does not affect earlier stages. Weaknesses: CodePipeline is slow to iterate (each self-mutation is a deploy), cross-region requires replication buckets, and the pipeline itself is a stack you must bootstrap by hand once (`cdk deploy PipelineStack` from a laptop, then never again).

### 8.2 GitHub Actions with OIDC (AWS) and Workload Identity Federation (GCP)

The keyless pattern on both clouds:

- AWS: an IAM OIDC identity provider for `token.actions.githubusercontent.com`, a role whose trust policy restricts `sub` to `repo:org/repo:ref:refs/heads/main` (or `environment:prod`), `aws-actions/configure-aws-credentials` with `role-to-assume`. That role should be allowed only to **assume the CDK bootstrap roles** (`cdk-<q>-deploy-role-*`, `-file-publishing-role-*`, `-lookup-role-*`); the CLI does the rest. Bootstrap those envs with `--trust` for the CI account if CI runs in a separate account. `cdk diff --change-set` on PRs (needs lookup + describe permissions and the ability to create change sets), `cdk deploy --require-approval never --ci` on main. `--change-set` diffs are more accurate (they see replacements) but need permissions to create a change set; `--no-change-set` is template-only.
- GCP: a `WorkloadIdentityPool` + `WorkloadIdentityPoolProvider` (OIDC issuer `https://token.actions.githubusercontent.com`, `attributeMapping` from `assertion.sub/repository/ref`, an `attributeCondition` restricting to your org), `google-github-actions/auth` with `workload_identity_provider` and either `service_account` (impersonation: grant `roles/iam.workloadIdentityUser` on the SA to `principalSet://iam.googleapis.com/projects/N/locations/global/workloadIdentityPools/POOL/attribute.repository/org/repo`) or direct WIF (grant roles to the principalSet directly; fewer moving parts, not supported by every API). Then `cdktf diff` on PRs (post the plan as a comment; `--no-color` and truncate), `cdktf deploy --auto-approve` on main. The deploy SA needs `roles/storage.objectAdmin` on the state bucket and whatever it manages; keep a separate, lesser SA for plan-on-PR so a malicious PR cannot apply. Organisation policy `constraints/iam.disableServiceAccountKeyCreation` enforces that nobody falls back to JSON keys.

Both need: concurrency control (one deploy at a time per environment — GitHub `concurrency:` groups; Terraform also has the state lock), a plan artefact that is exactly what gets applied (`terraform plan -out` then `apply plan.out`; in CDKTF, `cdktf deploy` re-plans, so treat the PR plan as advisory or drive Terraform directly from the synthesized `cdktf.out/stacks/<id>` in CI), and `cdk.context.json` committed so CI does not need lookup permissions.

Minimal skeletons (the modules have the full workflows):

```yaml
# AWS: plan on PR, deploy on main
permissions: { id-token: write, contents: read, pull-requests: write }
jobs:
  diff:
    if: github.event_name == 'pull_request'
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: arn:aws:iam::111111111111:role/gha-cdk-plan, aws-region: us-east-1 }
      - run: npx cdk diff --change-set --ci 'prod-*' 2>&1 | tee diff.txt   # add --fail if the job should go red on differences
  deploy:
    if: github.ref == 'refs/heads/main'
    concurrency: { group: deploy-prod, cancel-in-progress: false }
    environment: prod                                                   # required reviewers live here
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: arn:aws:iam::111111111111:role/gha-cdk-deploy, aws-region: us-east-1 }
      - run: npx cdk deploy --all --require-approval never --ci --concurrency 4 --outputs-file outputs.json
```

```yaml
# GCP: same shape with Workload Identity Federation
permissions: { id-token: write, contents: read, pull-requests: write }
jobs:
  plan:
    steps:
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: projects/123456789/locations/global/workloadIdentityPools/github/providers/github
          service_account: cdktf-plan@platform-prod.iam.gserviceaccount.com
      - run: npx cdktf diff prod-orders --no-color 2>&1 | tee plan.txt
  apply:
    if: github.ref == 'refs/heads/main'
    concurrency: { group: apply-prod }
    environment: prod
    steps:
      - uses: google-github-actions/auth@v2
        with: { workload_identity_provider: ..., service_account: cdktf-apply@platform-prod.iam.gserviceaccount.com }
      - run: npx cdktf deploy 'prod-*' --auto-approve
```

Two service accounts on GCP (plan: `roles/viewer` + state-bucket `objectViewer`; apply: the real roles + `objectAdmin`) and two roles on AWS (plan: assume only the lookup role plus `cloudformation:CreateChangeSet/DescribeChangeSet/DeleteChangeSet`; deploy: assume the deploy/publishing roles) are the minimum separation. A PR from a fork must never reach the apply identity.

### 8.3 Drift and hygiene jobs

Scheduled workflow: AWS `cdk drift --fail` per stack (or `aws cloudformation detect-stack-drift`), alert on exit code; GCP `cdktf diff --refresh-only` or `terraform plan -detailed-exitcode -refresh-only`, alert on 2. Weekly `cdk gc --unstable=gc --action=print` then `tag`/`delete-tagged` with a buffer; on GCP a lifecycle rule on the asset bucket. Monthly: bump `aws-cdk-lib`/CLI and providers in a PR whose only review artefact is the `diff` output — the framework upgrade *is* an infrastructure change.

---

## 9. Organisation scale

Modules: [A09](../aws-cdk/src/modules/09-multi-account-and-multi-region/README.md) · [B09](../cdktf-gcp/src/modules/09-multi-project-and-org-scale/README.md)

### 9.1 AWS: accounts, regions, bootstrap trust, qualifiers

The unit of isolation is the **account**; the unit of deployment is `(account, region)`, and every such pair must be bootstrapped. Model it as `Stage × Environment`: a `Stage` subclass (`OrdersStage`) that instantiates the stacks, instantiated once per environment with `env: { account, region }` and the tier from `shared/ENVIRONMENTS`. Stage names prefix stack names (`prod-Orders-Api`), which is why `shared/src/policy.ts` allows `env-PascalCase` ids.

Bootstrap trust: `cdk bootstrap aws://ACCT/REGION --trust PIPELINE_ACCT --trust-for-lookup PIPELINE_ACCT --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess` (narrow that policy; combine with `--custom-permissions-boundary`). The **qualifier** (`--qualifier abc123`) namespaces every bootstrap resource so two independent platforms (or two versions of the bootstrap) coexist in one account; the app must then set `DefaultStackSynthesizer({ qualifier })` or the `@aws-cdk/core:bootstrapQualifier` context. `DefaultStackSynthesizer` props also let you rename roles/buckets to match an organisation-owned bootstrap template (`cdk bootstrap --template custom.yaml` after `--show-template`), which is how large orgs make bootstrap a StackSet.

Regions: `crossRegionReferences` for the few values that must cross (certificates in `us-east-1` for CloudFront, Route 53), `Stack.regionalFact()` for partition/region-dependent constants, `@aws-cdk/core:target-partitions` if you build for `aws-cn`/`aws-us-gov`. Feature flags live in `cdk.json` `context`; `cdk flags --unstable=flags` lists and toggles them; new flags default to the old behaviour, `cdk init` templates set them all to recommended, and a library upgrade never flips one silently — you own the migration of each.

Org-level plumbing: Control Tower / Organizations vend accounts; a StackSet (or a CDK app run per account) applies the bootstrap; SCPs cap what the cfn-exec role may do; a central "platform" account hosts the pipeline and is trusted by all.

### 9.2 GCP: projects, folders, Shared VPC, provider aliases

The unit of isolation is the **project** (billing, quotas, IAM, APIs); folders group projects for IAM/org-policy inheritance; the organisation is the root. A **project factory** (module B09) is a construct that creates `Project` (with `deletionPolicy`, billing account, folder), enables APIs (`ProjectService` for each — `serviceusage`, `cloudresourcemanager`, `compute`, `iam` first, with `disableOnDestroy: false` so destroying the factory does not disable APIs other stacks use), creates the default service accounts' replacements, attaches to the Shared VPC (`ComputeSharedVpcServiceProject`), and applies labels. Shared VPC: a host project owns `ComputeNetwork`/`ComputeSubnetwork`; service projects attach and get subnet-level IAM (`ComputeSubnetworkIamMember` `roles/compute.networkUser`). Regions are provider aliases: `new GoogleProvider(this, 'google-euw4', { alias: 'euw4', region: 'europe-west4' })` and `provider: euw4` on each resource; `google-beta` is a second provider (`GoogleBetaProvider`) needed for beta fields and resources.

State layout: one GCS bucket per environment class (or per folder), `prefix` per stack, uniform bucket-level access, versioning, CMEK, and the deploy SA per environment as the only writer. Stack-per-project with dependencies (`stack.addDependency(hostProjectStack)`) is the normal shape; `cdktf deploy '*'` orders them.

### 9.3 One environment model for both

`shared/src/environment.ts` is the business definition (`dev/staging/prod`, retention, approval, HA, log retention, owner, cost centre). Each track adds a technical map: AWS `{ account, region }` per tier and per stage; GCP `{ projectId, region, folder, stateBucket }` per tier. The capstones read the same `ENVIRONMENTS` and disagree only in that map. The value of doing this is not code sharing (it is a 60-line file) but *governance* sharing: a FinOps rule ("every resource carries `cost-center`") is written once, in `mandatoryTags()`, and enforced by one policy walker in both.

```ts
import { ENVIRONMENTS, EnvironmentTier, mandatoryTags, resourceName, regionShortCode } from '@cdk-mastery/shared';

// AWS: business tier -> technical target, then Stage × Environment
const AWS_TARGETS: Record<EnvironmentName, cdk.Environment> = { dev: { account: '111111111111', region: 'us-east-1' }, /* ... */ };
for (const tier of Object.values(ENVIRONMENTS)) {
  const stage = new OrdersStage(app, tier.name, { env: AWS_TARGETS[tier.name], tier });
  for (const [k, v] of Object.entries(mandatoryTags(tier, 'orders'))) cdk.Tags.of(stage).add(k, v);
  if (tier.retainStatefulResources) cdk.Aspects.of(stage).add(new RetainStateful(), { priority: cdk.AspectPriority.MUTATING });
}

// GCP: business tier -> project/region/state, one TerraformStack per tier per layer
const GCP_TARGETS: Record<EnvironmentName, { projectId: string; region: string; stateBucket: string }> = { /* ... */ };
for (const tier of Object.values(ENVIRONMENTS)) {
  const t = GCP_TARGETS[tier.name];
  const stack = new OrdersStack(app, `${tier.name}-orders`, { tier, projectId: t.projectId, region: t.region });
  new GcsBackend(stack, { bucket: t.stateBucket, prefix: `orders/${tier.name}` });
  Aspects.of(stack).add(new LabelEverything(mandatoryTags(tier, 'orders')));   // normaliseLabelKey/Value inside
}
// The same name rule feeds both: resourceName({ org: 'cdkm', service: 'orders', env: tier.name, component: 'api', region: regionShortCode(t.region) })
```

---

## 10. Escape hatches, custom logic, migration

Modules: [A10](../aws-cdk/src/modules/10-escape-hatches-custom-resources-and-migration/README.md) · [B10](../cdktf-gcp/src/modules/10-escape-hatches-hcl-migration-and-interop/README.md)

### 10.1 Escape hatches

AWS CDK, from least to most invasive:

1. Use the L2's typed API. Read the source; most "missing" props exist under another name.
2. `const cfn = l2.node.defaultChild as CfnBucket; cfn.propertyName = ...` — typed L1 property assignment.
3. `cfn.addPropertyOverride('Path.To.Prop', value)` / `addPropertyDeletionOverride` / `addOverride('Metadata.x', v)` / `addDeletionOverride` — raw JSON path edits applied *after* the L1 renders. Arrays by index (`GlobalSecondaryIndexes.0.Projection`). Invisible to cdk-nag (which reads the L1, not the override) — acknowledge the rule with a reason.
4. `cfn.cfnOptions.condition/metadata/updateReplacePolicy/deletionPolicy/creationPolicy/updatePolicy` — template-level options.
5. `cfnResource.overrideLogicalId()`; `stack.renameLogicalId()`.
6. A raw `CfnResource(this, 'X', { type: 'AWS::Service::NewThing', properties })` for a type without an L1 yet.
7. `Stack.templateOptions`, `stack.addTransform('AWS::Serverless-2016-10-31')`, and reaching into another construct's children with `node.findChild` — use to unblock, then open an issue.
8. **Un-escape hatch**: `CfnInclude` to lift raw templates into the tree (below).

CDKTF, similarly:

1. Typed props from the binding.
2. `resource.addOverride('path.to.attr', value)` — JSON path edit of the rendered block; `addOverride('lifecycle.ignore_changes', ['labels'])` when the typed `lifecycle` does not cover it; `stack.addOverride('terraform.required_version', '>= 1.9')` at the stack level; `backend.addOverride('use_lockfile', true)` for backend features the 0.21 typings lack.
3. `resource.overrideLogicalId()`.
4. A raw `new TerraformResource(this, 'x', { terraformResourceType: 'google_new_thing', terraformGeneratorMetadata: { providerName: 'google' }, ... })` with `addOverride` for its attributes — for resources newer than your bindings.
5. `cdktf get` against a newer provider version to regenerate bindings; `cdktf provider upgrade`.
6. `TerraformHclModule` to consume any registry/git/local module untyped; `Fn.rawString`/`call()` for functions the typings lack.
7. `//metadata` and `stack.addOverride('//', ...)` are comments; `App({ hclOutput: true })` when a human must read the result.

### 10.2 Custom logic at deploy time

AWS CDK has a whole subsystem because CloudFormation has **custom resources**: a resource type whose create/update/delete are handled by a Lambda (or SNS). Two abstractions:

- `custom-resources.Provider` (the "provider framework"): you supply `onEventHandler` (returns physical ID + data) and optionally `isCompleteHandler` (polled every `queryInterval` up to `totalTimeout`, via a Step Functions waiter) and the framework handles the CloudFormation response protocol, retries, timeouts and errors. Use for anything with a lifecycle: seed a database schema, register a SaaS webhook, run a migration. Rules: idempotent handlers; `Delete` must succeed on a resource that was never created; physical ID changes on update mean CloudFormation will call `Delete` on the old one afterwards; never do slow work in `onEvent` (15-minute Lambda limit) — use `isComplete`.
- `AwsCustomResource`: declarative single SDK calls per lifecycle event (`onCreate/onUpdate/onDelete: { service, action, parameters, physicalResourceId }`) with `AwsCustomResourcePolicy.fromSdkCalls({ resources })`, `getResponseField()` to read results into tokens. Use for "call one API that CloudFormation does not cover". Pin `installLatestAwsSdk: false` (the default under `@aws-cdk/customresources:installLatestAwsSdkDefault: false`) unless you need a newer SDK than the runtime ships, and know that `logApiResponseData` may log secrets.

Both are Lambda functions in your stack with their own roles, log groups and cold starts; both make `cdk destroy` depend on code that must still work at destroy time. Keep them small, tested, and few.

CDKTF has **no custom resource mechanism**, because Terraform does not: a provider is the only thing that can implement a resource lifecycle. What you do instead:

- **Find a provider.** For most "custom" needs a provider exists (`http` data source, `external` data source, `null`/`time`, `local`, `archive`, `restapi`, `mastercard/restapi`, the `google` provider's `google_client_config`/`google_cloud_run_v2_job` for one-off jobs).
- **`terraform_data` + `local-exec`/`remote-exec` provisioners** (`DataResource` in `cdktf`, Terraform ≥ 1.4; replaces `null_resource`). `triggersReplace` re-runs the provisioner; `provisioners: [{ type: 'local-exec', command, when: 'destroy' }]` for teardown. Provisioners are Terraform's documented last resort: not idempotent, not planned, not visible in state beyond triggers, run on the machine doing the apply (your CI runner needs the tooling), and fail the apply if the command fails.
- **`external` data source** (`data "external"` running a program that returns JSON) for read-only computed values at plan time. Runs on every plan.
- **Provider-defined functions** (Terraform ≥ 1.8): pure functions such as `provider::google::name_from_id`, `project_from_id`, `region_from_id`, `zone_from_id`, `location_from_id`. `cdktf` 0.21 has no typed bindings; `call('provider::google::name_from_id', [id])` renders them.
- **Write a provider** (Terraform Plugin Framework, Go) when you need a real lifecycle. It is a week of work for a small API and it is the *right* answer for anything that has state.
- **Do it outside Terraform**: a Cloud Run job or Cloud Build step triggered by CI after apply, with the Terraform outputs as inputs. This is what most teams actually do for schema migrations.

The same need — "run a schema migration once per deploy, after the database exists" — in each:

```ts
// AWS CDK: provider framework. Lifecycle-aware, retried, visible in CloudFormation events.
const provider = new cr.Provider(this, 'MigrateProvider', {
  onEventHandler: migrateFn,                       // returns { PhysicalResourceId, Data }
  isCompleteHandler: pollFn,                       // returns { IsComplete }
  queryInterval: cdk.Duration.seconds(30), totalTimeout: cdk.Duration.minutes(30),
});
new cdk.CustomResource(this, 'Migrate', {
  serviceToken: provider.serviceToken,
  properties: { SchemaVersion: '42', DbArn: db.clusterArn },   // change => Update event; unchanged => no call
});

// AWS CDK: one SDK call, no code of your own.
new cr.AwsCustomResource(this, 'PutParam', {
  onUpdate: { service: 'SSM', action: 'PutParameter', parameters: { Name: '/x', Value: 'y', Overwrite: true, Type: 'String' },
              physicalResourceId: cr.PhysicalResourceId.of('/x') },
  policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
});

// CDKTF: terraform_data + local-exec. Not planned, not retried, runs on the CI runner, re-runs when triggers change.
new DataResource(this, 'migrate', {
  triggersReplace: { schemaVersion: '42', instance: db.connectionName },
  dependsOn: [db],
  provisioners: [{ type: 'local-exec', command: 'npm run migrate', environment: { DB: db.connectionName } }],
});
// CDKTF: the honest version — a Cloud Run job resource, executed by CI after `cdktf deploy` via gcloud run jobs execute.
```

`DataResource` is the `terraform_data` binding shipped in `cdktf` itself (no provider needed, Terraform ≥ 1.4); `null_resource` from the `null` provider is the legacy spelling.

Escape hatches side by side, on the same intent ("set a property the L2/binding does not expose yet"):

```ts
// AWS CDK
const cfnTable = table.node.defaultChild as dynamodb.CfnTable;
cfnTable.addPropertyOverride('WarmThroughput', { ReadUnitsPerSecond: 12000 });
cfnTable.addPropertyDeletionOverride('ContributorInsightsSpecification');
cfnTable.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;
// CDKTF
bucket.addOverride('soft_delete_policy.0.retention_duration_seconds', 0);   // list-of-blocks index syntax
bucket.addOverride('lifecycle.prevent_destroy', true);
stack.addOverride('terraform.required_version', '>= 1.9.0');
```

### 10.3 Migration primitives

AWS:

- `cloudformation-include.CfnInclude(this, 'Legacy', { templateFile, parameters, preserveLogicalIds (default true), loadNestedStacks })` — parses an existing template into L1 constructs in your stack; `getResource('LogicalId')` returns the typed `Cfn*` so you can mutate, reference, and progressively replace with L2s by `overrideLogicalId` on the new L2's child. Same logical IDs ⇒ CloudFormation sees an update, not a replacement. See [MIGRATION](MIGRATION.md).
- `cdk migrate --from-path template.yaml | --from-stack --stack-name X | --from-scan` — generates a new CDK app (L1-based, via `CfnInclude`-like codegen) from a template, a deployed stack, or an IaC-generator scan of the account. A starting point, not an end state.
- `cdk import [--resource-mapping file.json | --resource-mapping-inline '{...}' | --record-resource-mapping out.json]` — CloudFormation resource import: adds constructs whose physical identifiers you supply into an existing stack; only import-supported types; the template must otherwise be unchanged; nested stacks unsupported; needs bootstrap ≥ 12. `cdk deploy --import-existing-resources` does it during a normal deploy for resources with custom physical names.
- `cdk refactor --unstable=refactor [--dry-run] [--override-file] [--additional-stack-name] [--revert]` — computes resource digests (type + properties + dependency digests) of deployed versus local stacks and finds moved/renamed resources (within or across stacks), then applies the mapping through CloudFormation's stack-refactoring API. The bundled README still says only `--dry-run` is supported while the CLI exposes `--force`/`--revert`; check `cdk refactor --help` on your version before relying on execution. Constraints: no resource additions/removals in the same refactor, no new stacks, no emptying a stack.
- `cdk orphan --unstable=orphan Stack/Path` — sets `DeletionPolicy: Retain`, replaces references with literals, removes the resource from the template. Pair with `cdk import` to swap construct types (the documented `Table` → `TableV2` path).

GCP/Terraform:

- `cdktf convert --language typescript [--stack] < main.tf` — HCL → TypeScript using the same provider schemas; output is literal (raw `TerraformResource`-style where it cannot type), needs hand cleaning, and does not carry state. `cdktf init --from-terraform-project DIR` does it at project creation.
- `resource.importFrom('projects/p/buckets/b', provider?)` — renders an `import` block (Terraform ≥ 1.5) so the next apply adopts the existing object into state; remove the call after apply. Every resource class also has a static `generateConfigForImport` for `terraform plan -generate-config-out`.
- `resource.moveTo('target')` with `addMoveTarget('target')` on the destination, or `moveToId('google_x.old_id')` / `moveFromId()` — renders `moved` blocks (Terraform ≥ 1.1) so a rename/re-parent is a state move, not destroy/create. Works only within one state file; across stacks you `terraform state mv -state-out` or `state pull`/`push`.
- Coexistence: HCL and CDKTF stacks share nothing but backends; `DataTerraformRemoteStateGcs` reads an HCL workspace's outputs, and HCL `terraform_remote_state` reads a CDKTF stack's. Migrate one root module at a time.
- `cdktf synth --hcl` for teams whose review, policy or ownership model requires HCL: CDKTF becomes a generator whose output is committed and applied by plain Terraform.

CDK ↔ CDKTF is not a migration; it is a re-platform (state models differ, resource models differ, identities differ). What survives is what was written against `constructs` alone: this repo's `shared/`, your environment model, naming rules, policy walkers, and any construct that only *orchestrates* (creates children from props) and delegates leaf resources through an interface. [MIGRATION](MIGRATION.md) has the playbooks.

---

## 11. How a master structures a platform repo

Modules: [A11](../aws-cdk/src/modules/11-capstone-platform/README.md) · [B11](../cdktf-gcp/src/modules/11-capstone-platform/README.md)

**Layout.** One monorepo (npm workspaces, pnpm or Nx) with: `packages/constructs-*` (versioned libraries, one per domain: network, data, compute, observability), `packages/environment` (the `shared/`-style business model), `apps/<service>` (one CDK/CDKTF app per deployable service, owned by the service team, depending on published construct versions, not on workspace `*`), `platform/bootstrap` (the bootstrap template / state buckets / WIF pools, applied by hand-off-a-laptop once and by a break-glass pipeline thereafter), `policy/` (aspects, cdk-nag packs, Rego), `.github/` (reusable workflows: `plan-on-pr`, `deploy`, `drift`, `upgrade`). Two-cloud shops keep both tracks in the same monorepo so the environment model is one package; they do not attempt one app that deploys both.

**Ownership.** `CODEOWNERS`: the platform team owns `packages/constructs-*`, `platform/`, `policy/` and the reusable workflows; service teams own `apps/<service>`; changes to a construct package require a review from the platform team *and* a synthesized-diff from a canary app that consumes it. Every stack has an `owner` tag/label from the environment model and a runbook link in the stack description.

**Versioning constructs.** Publish to a private registry with semver and a changelog that names logical-ID impact. Consumers pin `^minor`. A `MAJOR` bump is the only place identity changes are allowed, and it ships with a codemod or an explicit `renameLogicalId`/`moved` recipe. Keep a `stability` field per construct (experimental/stable/deprecated) and a deprecation window of two minors.

**Release trains.** Framework upgrades on a fixed cadence (fortnightly), bundled in one PR whose review artefact is the aggregated `cdk diff`/`cdktf diff` across all apps in a staging environment. Provider upgrades on GCP are the same discipline, more frequent (weekly provider releases), and must be pinned in `cdktf.json`/`package.json` and the lock file. Never let apps float on `latest`. The pipeline that deploys the platform's own constructs (canary app → staging → prod) is the pattern that `pipelines.CodePipeline` waves encode; on GCP it is a GitHub environment with a required reviewer.

**Rolling a breaking construct change across N stacks** (a common Staff interview question, answered in [INTERVIEW-QA](INTERVIEW-QA.md)): make the new behaviour opt-in behind a prop or context flag; ship the construct minor; run the aggregated diff; flip the flag per app in order of blast radius (dev → staging → prod, stateless before stateful); for identity changes, generate the mapping once (`cdk refactor --dry-run`/`moved` blocks) and apply it in the same PR as the flip; remove the old path in the next major.

**On-call for IaC.** Deployments are production changes: a deploy fails, pages the owning team; a drift job fires, opens a ticket for the owner; a bootstrap/state-bucket change pages the platform team. Runbooks per failure class (`UPDATE_ROLLBACK_FAILED`, stuck state lock, state serial mismatch, "export in use", "API not enabled", "IAM eventual consistency") — the [GOTCHAS](GOTCHAS.md) file is the seed for those. Break-glass: a documented, audited way to `terraform state rm`/`cdk orphan`/`ContinueUpdateRollback` that requires two people. Post-incident: was it preventable by an aspect, a policy, or a test? Add one.

**What not to do.** One giant stack "because cross-stack references are annoying"; environment-agnostic prod stacks; `latest` on anything; bundling in Docker on shared runners without caching; a construct library that re-exports `aws-cdk-lib` types under new names; secrets in `cdk.context.json` or state without CMEK; letting the deploy role be assumable by humans; treating `cdk diff`/`plan` output as optional reading.
