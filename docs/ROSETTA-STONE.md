# Rosetta Stone

> One concept per row, five dialects per column. Read after module 05 and again after module 10 (see [CURRICULUM](CURRICULUM.md)). The [MASTERY-GUIDE](MASTERY-GUIDE.md) has the "why" behind every row; the [CHEATSHEET](CHEATSHEET.md) has the exact flags.

Column key: **AWS CDK** = `aws-cdk-lib` 2.269.0 / CLI 2.1141.0 · **CDKTF** = `cdktf` 0.21.0 with `@cdktf/provider-google` 16.12.1 · **Terraform HCL** = Terraform/OpenTofu ≥ 1.9 · **CloudFormation** = raw templates · **Pulumi** = TypeScript SDK (for orientation only; not covered by the modules).

## Structure

| Concept | AWS CDK | CDKTF | Terraform HCL | CloudFormation | Pulumi |
|---|---|---|---|---|---|
| App / program root | `new App()`; `app.synth()` implicit under the CLI | `new App()`; **`app.synth()` required** | A directory (root module) | — (a template is the unit) | `pulumi.Config()` + top-level program; `Pulumi.yaml` |
| Stack / deployable unit | `Stack` → one CloudFormation stack, one template, one `env` | `TerraformStack` → one root module, one backend, one state | Root module + backend + workspace | Stack | Stack (`Pulumi.<stack>.yaml`) = one state |
| Construct / composition unit | `Construct` (from `constructs`); L1 `Cfn*`, L2, L3 | `Construct` (from `constructs`); generated bindings only | `module` block | Nested stack, macros, modules (Registry) | `ComponentResource` |
| Resource | L1 `CfnBucket` / L2 `Bucket` | `StorageBucket` (one class per provider resource) | `resource "google_storage_bucket" "x"` | `Resources.X: { Type: AWS::S3::Bucket }` | `new gcp.storage.Bucket()` |
| Data lookup | Context providers (`Vpc.fromLookup`, synth-time, cached in `cdk.context.json`) or `fromXxxAttributes` (no lookup) | `DataGoogle*` data sources (plan-time, never cached) | `data "google_compute_network"` | Parameters of SSM type; `Fn::ImportValue`; no generic lookup | `gcp.compute.getNetwork()` (invoke; program-time, async) |
| Provider configuration | Implicit (the CLI's credentials + `env`); `DefaultStackSynthesizer` for roles | `new GoogleProvider(this, 'google', { project, region, alias? })` — required per stack | `provider "google" { ... }` + `required_providers` | — | `new gcp.Provider('p', {...})` + `provider:` opt |
| Environment / account / project | `env: { account, region }` on `Stack`; `Stage` groups stacks per env; `CDK_DEFAULT_ACCOUNT/REGION` | Provider `project`/`region`; a stack per env; `TF_VAR_*` / config for the rest | Provider block + workspaces or directories | `AWS::AccountId`/`AWS::Region` pseudo-params; StackSets across accounts | Stack config `gcp:project`; one Pulumi stack per env |
| Bootstrap / prerequisites | `cdk bootstrap` (bucket, ECR, 5 roles, SSM version; v32 in CLI 2.1141) | None; create the state bucket out of band | None; create the backend out of band | None | `pulumi login` to a backend (Pulumi Cloud, S3, GCS, local) |
| Backend / where state lives | CloudFormation (managed) | `GcsBackend` / `S3Backend` / `CloudBackend` / `LocalBackend` ... one per stack | `terraform { backend "gcs" {} }` | CloudFormation (managed) | `pulumi login gs://bucket` |

## Values and logic

| Concept | AWS CDK | CDKTF | Terraform HCL | CloudFormation | Pulumi |
|---|---|---|---|---|---|
| Tokens / deferred values | `Token`, `Lazy.string/number/list/any`, `Token.isUnresolved` | `Token.asString/asNumber/asList/...`, `Lazy.stringValue/...`, `Token.isUnresolved` | All expressions are lazy by nature (`known after apply`) | `Ref`/`Fn::GetAtt` | `Output<T>`, `pulumi.interpolate`, `.apply()` |
| Intrinsic functions | `Fn.join/select/split/sub/getAtt/ref/importValue/getStackOutput/conditionIf/cidr/base64/findInMap` | `Fn.*` (every built-in), `Fn.conditional`, `Fn.lookupNested`, `Fn.rawString`, `call(name,args)` for the rest; `Op.*` operators | Built-in functions, `? :`, operators | `Fn::Join/Select/Sub/GetAtt/If/...` | Plain TypeScript inside `.apply()` |
| Parameters / variables | `CfnParameter` (deploy-time; discouraged) — prefer props/context | `TerraformVariable` (`type`, `default`, `validation`, `sensitive`, `nullable`); `--var`/`--var-file`/`TF_VAR_*` | `variable` block | `Parameters` | `pulumi.Config().require('x')` |
| Context / locals | `app.node.tryGetContext('k')`, `cdk.json` `context`, `-c k=v`, `CDK_CONTEXT_JSON` | `app.node.tryGetContext`, `cdktf.json` `context`, `CDKTF_CONTEXT_JSON`; `TerraformLocal` for HCL-side locals | `locals` | `Mappings` | Config + TS constants |
| Loops | TypeScript `for`/`map` at synth time only | Synth-time TS loops **or** `TerraformIterator` (`for_each`), `TerraformCount` (`count`), `iterator.dynamic()` (dynamic blocks) | `for_each`, `count`, `dynamic`, `for` expressions | Macros / `Fn::ForEach` (language transform) | TS loops (program-time; values via `.apply`) |
| Conditionals | TS `if` at synth time; `CfnCondition` + `cfnOptions.condition` for deploy-time | TS `if` at synth time; `Fn.conditional()` / `conditional()` for apply-time; `count = cond ? 1 : 0` idiom via `TerraformCount` | `? :`, `count`/`for_each` gates | `Conditions` + `Fn::If` | TS `if`; `.apply()` for output-dependent |
| Outputs | `CfnOutput` (+ `exportName`) | `TerraformOutput` (`sensitive`, `staticId`) | `output` | `Outputs` | `export const x = ...` |
| Cross-stack reference | Automatic: Export/`Fn::ImportValue` (strong), `Fn::GetStackOutput` (weak, flag `defaultCrossStackReferences`, 2.254.0+), SSM-backed cross-region (`crossRegionReferences`) | Automatic: `TerraformOutput` on producer + `DataTerraformRemoteState<Backend>` on consumer + manifest dependency | `terraform_remote_state` data source or data sources by name | `Export`/`Fn::ImportValue` | `StackReference` |
| Secrets | `SecretValue`, `secretsmanager.Secret`, dynamic references `{{resolve:secretsmanager:...}}`; never plain in template | `sensitive: true` on variables/outputs; `SecretManagerSecretVersion` data source; state contains secrets → CMEK on bucket | `sensitive`, `ephemeral` (1.10+), write-only attrs (1.11+) | Dynamic references, `NoEcho` | `pulumi.secret()`, encrypted in state |
| Tags / labels | `Tags.of(scope).add(k, v, { include/excludeResourceTypes, priority })`; `StackProps.tags` under `explicitStackTags` | No built-in; an aspect that sets `labels` per resource; provider `defaultLabels` | `default_labels` on provider; `labels` per resource | `Tags` per resource; stack tags propagate | `pulumi:tags` / per-resource; transformations |

## Behaviour and lifecycle

| Concept | AWS CDK | CDKTF | Terraform HCL | CloudFormation | Pulumi |
|---|---|---|---|---|---|
| Synthesis | `cdk synth` → `cdk.out/` (templates, assets, manifest, tree) | `cdktf synth [--hcl]` → `cdktf.out/stacks/<id>/cdk.tf.json` | — (HCL is the source) | — | — (program runs at `preview`/`up`) |
| Plan / diff | `cdk diff [--change-set] [--fail]`; `cdk deploy --method prepare-change-set` | `cdktf diff` (= `terraform plan`); `--refresh-only` | `terraform plan [-out] [-detailed-exitcode]` | Change set | `pulumi preview` |
| Deploy | `cdk deploy [--method change-set|direct] [--hotswap] [--no-rollback] [--concurrency N]` | `cdktf deploy [--auto-approve] [--parallelism N] [--skip-synth]` | `terraform apply` | `CreateChangeSet`/`ExecuteChangeSet`, `UpdateStack` | `pulumi up` |
| Destroy | `cdk destroy`; `RemovalPolicy`/`DeletionPolicy` decides retention | `cdktf destroy`; `lifecycle.preventDestroy`, provider `deletion_protection`/`deletionPolicy` | `terraform destroy` | `DeleteStack`; `DeletionPolicy` | `pulumi destroy`; `protect: true` |
| Failure semantics | Rollback to last template (or paused with `--no-rollback`); `cdk rollback` | Partial apply persists; re-run | Same | Same as CDK | Partial persists; re-run |
| State inspection | `aws cloudformation describe-stack-resources`, `cdk drift` | `terraform state list/show` inside `cdktf.out/stacks/<id>`; `cdktf output` | `terraform state *` | Console / API | `pulumi stack export` |
| Drift | `cdk drift [--fail]`; `cdk deploy --revert-drift` | Every plan refreshes; `cdktf diff --refresh-only` | `plan -refresh-only` | Drift detection API | `pulumi refresh` |
| Import existing resource | `cdk import [--resource-mapping]`; `cdk deploy --import-existing-resources`; `cdk migrate` | `resource.importFrom(id)` (`import` block); `generateConfigForImport`; `terraform import` | `import` block (1.5+), `terraform import` | `ImportExistingResources` change-set type | `pulumi import`; `import:` resource opt |
| Rename without replace | `overrideLogicalId()`, `renameLogicalId()`; `cdk refactor --unstable=refactor` | `moveTo()`/`addMoveTarget()`/`moveToId()`/`moveFromId()` (`moved` blocks); `overrideLogicalId()` | `moved` block (1.1+); `terraform state mv` | Stack refactoring API | `aliases: [...]` resource opt |
| Detach without delete | `cdk orphan --unstable=orphan`; `DeletionPolicy: Retain` then remove | `removed` block via `addOverride` (1.7+); `terraform state rm` | `removed` block; `state rm` | Retain + remove from template | `retainOnDelete`; `pulumi state delete` |
| Escape hatch | `node.defaultChild as CfnX`, `addPropertyOverride`, `addOverride`, `cfnOptions`, raw `CfnResource` | `addOverride('path', v)` on element/stack, raw `TerraformResource`, `TerraformHclModule` | — (already raw) | — | `transformations`, `ignoreChanges` |
| Custom logic at deploy time | `custom-resources.Provider`, `AwsCustomResource`, `CustomResource` | None. `DataResource` (`terraform_data`) + provisioners, `external` data source, provider-defined functions via `call()`, or write a provider | Same as CDKTF | `AWS::CloudFormation::CustomResource` | Dynamic providers (`pulumi.dynamic.Resource`) |
| Assets / local files | `Asset`, `Code.fromAsset`, `DockerImageAsset`, `BucketDeployment`; staged in `cdk.out`, published to bootstrap bucket/ECR by `cdk-assets` | `TerraformAsset` (FILE/DIRECTORY/ARCHIVE) copied into `cdktf.out`; you upload via a resource (`StorageBucketObject`) | `archive_file` data source + `google_storage_bucket_object` | Not supported (pre-upload) | `pulumi.asset.FileArchive` |

## Governance, testing, tooling

| Concept | AWS CDK | CDKTF | Terraform HCL | CloudFormation | Pulumi |
|---|---|---|---|---|---|
| Aspects / tree visitors | `Aspects.of(scope).add(aspect, { priority })`, `AspectPriority.MUTATING/DEFAULT/READONLY`, stabilisation loop | `Aspects.of(scope).add(aspect)` — no priority, one pass | — | — | Stack/resource transformations |
| Policy as code | cdk-nag 3 (`Validations.of(app).addPlugins(new AwsSolutionsChecks(app))`, `Validations.of(x).acknowledge({id, reason})`); `Validations` plugins; CloudFormation Guard/Hooks | Aspects + `Annotations.addError`; conftest/OPA on `cdk.tf.json` or plan JSON; Sentinel (HCP TF); `precondition`/`postcondition` | Same as CDKTF; checkov/tfsec/trivy on HCL | Guard, Hooks, cfn-lint, cfn_nag | CrossGuard policy packs |
| Org-level guardrails | SCPs, permission boundaries (`PermissionsBoundary.fromName` on Stage/Stack; bootstrap `--custom-permissions-boundary`), Config | Org policies (`OrgPolicyPolicy`), folder IAM, VPC-SC, SCC | Same resources in HCL | SCPs, permission boundaries | Cloud-native |
| Unit-test API | `assertions`: `Template.fromStack`, `hasResourceProperties`, `resourceCountIs`, `Match.*`, `Capture`, `Annotations.fromStack` | `Testing.synth/synthScope/fullSynth`; jest matchers `toHaveResourceWithProperties`, `toHaveDataSource`, `toHaveProvider`, `toBeValidTerraform`, `toPlanSuccessfully` | `terraform test` (`.tftest.hcl`, 1.6+), terratest | cfn-lint, taskcat | `@pulumi/pulumi/testing` mocks |
| Snapshot | `expect(Template.fromStack(s).toJSON()).toMatchSnapshot()` | `expect(Testing.synth(s)).toMatchSnapshot()` | Plan JSON in CI | Template file diff | Snapshot of `pulumi preview --json` |
| Integration test | `@aws-cdk/integ-tests-alpha` + `integ-runner` | Ephemeral stack + assertions script | terratest | taskcat | Pulumi Automation API |
| Language server / IDE | `cdk lsp` (CLI 2.1141) | TypeScript LSP | `terraform-ls` | cfn-lsp-extra | TS LSP |
| Version pinning | `aws-cdk-lib` exact, `aws-cdk` CLI separately (independent trains since 2.1000.0, 2025-02) | `cdktf` = `cdktf-cli` minor; provider bindings major ↔ cdktf minor; provider version in `cdktf.json` | `required_version`, `required_providers`, `.terraform.lock.hcl` | — | SDK version + provider plugin version |
| Feature flags | `cdk.json` `context` `@aws-cdk/...:flag`; `cdk flags --unstable=flags`; `cx-api/lib/features` | None (behaviour changes come with minors) | None | — | None |
| CLI unstable gate | `--unstable=refactor|gc|orphan|flags|diagnose|validate` | `cdktf watch` marked experimental | — | — | — |

## CLI commands

| Task | AWS CDK | CDKTF | Terraform HCL |
|---|---|---|---|
| Scaffold | `cdk init app --language typescript` | `cdktf init --template typescript [--providers hashicorp/google] [--from-terraform-project DIR]` | `terraform init` (no scaffold) |
| List units | `cdk ls [--long]` | `cdktf list` | `terraform workspace list` |
| Synthesize | `cdk synth [STACK] [--quiet] [-o DIR]` | `cdktf synth [--hcl] [-o DIR]` | — |
| Preview | `cdk diff [--change-set|--no-change-set] [--template file]` | `cdktf diff [STACK] [--refresh-only] [--var k=v]` | `terraform plan` |
| Apply | `cdk deploy [STACKS|--all] [--require-approval never] [--exclusively]` | `cdktf deploy [STACKS|'*'] [--auto-approve] [--parallelism N]` | `terraform apply` |
| Destroy | `cdk destroy [STACKS] [--force]` | `cdktf destroy [STACKS] [--auto-approve]` | `terraform destroy` |
| Outputs | `cdk deploy --outputs-file f.json` | `cdktf output [--outputs-file f.json] [--outputs-file-include-sensitive-outputs]` | `terraform output -json` |
| Bindings | — (in `aws-cdk-lib`) | `cdktf get`, `cdktf provider add|list|upgrade [--force-local]` | `terraform init -upgrade` |
| Convert | `cdk migrate --from-path|--from-stack|--from-scan` | `cdktf convert --language typescript [--stack] < main.tf` | — |
| Import | `cdk import` | (code) `importFrom` then `cdktf deploy` | `terraform import` / `import` block |
| Refactor | `cdk refactor --unstable=refactor --dry-run` | (code) `moveTo`/`moveToId` then `cdktf deploy` | `moved` block / `terraform state mv` |
| Debug | `cdk doctor`, `cdk diagnose --unstable=diagnose`, `--debug-app`, `-v -v` | `cdktf debug`, `CDKTF_LOG_LEVEL=debug`, `TF_LOG=DEBUG` | `TF_LOG` |
| Watch | `cdk watch` (= `deploy --watch --hotswap-fallback`) | `cdktf watch` (experimental) | — |
| Housekeeping | `cdk gc --unstable=gc`, `cdk context --clear`, `cdk notices`, `cdk acknowledge ID` | `cdktf login`, `cdktf completion` | `terraform providers lock` |

## Same word, different meaning

| Word | In AWS CDK | In CDKTF / Terraform | In CloudFormation | In Pulumi / Kubernetes |
|---|---|---|---|---|
| **Stack** | A construct that renders one CloudFormation stack; has `env`, synthesizer, 500-resource limit | A construct that renders one root module with one backend and one state; no resource limit, no rollback | The deployed unit with server-side state and events | Pulumi: a named state (`dev`, `prod`) of one program. Kubernetes: nothing (Helm "release"). |
| **Output** | `CfnOutput`: a template output, possibly exported; also the automatic vehicle for cross-stack refs | `TerraformOutput`: a root-module output, stored in state, readable via `terraform_remote_state`; `sensitive` matters | `Outputs` section | Pulumi: `Output<T>` is a *type* (a promise), not an exported value |
| **Provider** | `custom-resources.Provider`: the Lambda-backed framework that *implements* a custom resource; also "context provider" (synth-time lookups) | `TerraformProvider`: the plugin that knows how to CRUD resources, configured per stack, possibly aliased | Not a concept (resource types are registered in the CloudFormation registry; "resource providers" implement them) | Pulumi: same as Terraform's; Kubernetes: cloud-controller-manager, roughly |
| **Resource** | L1 `CfnResource`: exactly one template resource. L2s are *constructs*, not resources | `TerraformResource`: one `resource` block; may expand to many instances with `count`/`for_each` | One `Resources` entry | Pulumi: `CustomResource` (one cloud object) vs `ComponentResource` (a grouping) |
| **Import** | `cdk import`: adopt an existing cloud object into a stack (CloudFormation resource import). Also `Fn.importValue`: read another stack's export. Also `Bucket.fromBucketName`: *reference* without adopting | `import` block / `importFrom()`: adopt into state. `cdktf get` imports *provider schemas* into code | `ImportExistingResources` | Pulumi `import`: adopt. Kubernetes: n/a |
| **Synth** | Renders the whole app into `cdk.out`; happens implicitly under the CLI and in `Template.fromStack` | Renders into `cdktf.out`; **must be called** (`app.synth()`); `Testing.synth` renders one stack to a JSON string | — | Pulumi has no synth; the program runs during `preview`/`up` |
| **Environment** | `{ account, region }` on a Stack; `Stage` is the grouping | Not a type; a stack instance + provider config + backend key | — | Pulumi: "stack"; GitHub: a protected deployment target |
| **Context** | A key/value bag (`cdk.json`, `-c`, lookups cache) that also carries **feature flags** | A key/value bag (`cdktf.json`, `CDKTF_CONTEXT_JSON`); no flags | — | Kubernetes: `kubectl` context (cluster+user) |
| **Aspect** | Tree visitor with priority, stabilisation loop | Tree visitor, single pass, registration order | — | Pulumi: transformation |
| **Module** | This repo's teaching unit; also an ECMAScript module | A Terraform module (`TerraformHclModule` / generated binding), which lives *inside* a stack's state | — | — |
| **Lookup** | Synth-time, cached, needs credentials and a concrete env | Plan-time data source, never cached | SSM parameter types at deploy time | Pulumi `get*()` invokes at program time |
| **Nested stack** | `NestedStack`: child template uploaded as an asset, one resource in the parent | No equivalent; a module is inside the same state; a dependent *stack* is a separate state | `AWS::CloudFormation::Stack` | — |
| **Workspace** | — | Terraform workspace (a named state under one backend prefix); CDKTF stacks are the recommended alternative | — | Pulumi: organisation/project grouping |
| **Bootstrap** | `cdk bootstrap`: the toolkit stack (bucket, ECR, roles, version) | Not a concept; you pre-create the state bucket | — | Pulumi: `pulumi login` |
| **Rollback** | Automatic on failure, to the previous template | Does not exist; partial apply persists | Same as CDK | Pulumi: none |
| **Drift** | On-demand detection for supported types; not auto-corrected | Detected by every plan via refresh; corrected by next apply unless `ignore_changes` | On-demand | `pulumi refresh` |
| **Asset** | Staged, hashed, published to the bootstrap bucket/ECR automatically | Copied into `cdktf.out`; uploaded only if you write a resource that does so | — | `pulumi.asset.*`, uploaded by the resource that uses it |

## No equivalent

AWS CDK has, CDKTF does not:

| AWS CDK feature | What you do in CDKTF |
|---|---|
| L2/L3 constructs with `grant*`, `metric*`, `connections`, secure defaults | Write your own constructs (module B05), consume registry modules via `TerraformHclModule`, encode defaults in a shared library |
| Custom resources (`Provider`, `AwsCustomResource`) | `DataResource` + provisioners, `external`, provider-defined functions via `call()`, or write a provider; run post-apply jobs from CI |
| `cdk bootstrap` (managed asset store + roles) | Create the state bucket/WIF pool once with a bootstrap stack that uses a local or separate backend |
| Automatic asset publishing (`cdk-assets`) | `TerraformAsset` + `StorageBucketObject` (or Cloud Build for images) |
| Cross-region references (`crossRegionReferences`) | Nothing needed: provider aliases per region inside one stack, or remote state |
| Feature flags with per-app opt-in | None; behaviour changes arrive with `cdktf` minors and provider majors |
| `Stage` (env-scoped sub-assembly) | Naming convention on stack ids (`prod-orders`) plus config |
| `Validations` plugins and cdk-nag rule packs | conftest/OPA, Sentinel, checkov on plan JSON or HCL output |
| Aspect priorities and stabilisation | Registration order; aspects that add aspects are not re-walked |
| `cdk watch`/`--hotswap` (bypass the engine for dev loops) | `cdktf watch` (experimental) still runs Terraform |
| `cdk refactor`/`cdk orphan`/`cdk gc`/`cdk drift`/`cdk lsp` | `moved`/`removed` blocks, bucket lifecycle rules, `plan -refresh-only`, TypeScript LSP |
| Self-mutating `pipelines.CodePipeline` | GitHub Actions / Cloud Build workflows you maintain |
| `CfnInclude` (lift a raw template into the tree) | `TerraformHclModule` (call HCL, opaque) or `cdktf convert` (translate, one-way) |
| Managed state and automatic rollback | Backend of your choice; no rollback |

CDKTF has, AWS CDK does not:

| CDKTF / Terraform feature | What you do in AWS CDK |
|---|---|
| A plan that refreshes real state every time | `cdk diff --change-set` (no refresh) + `cdk drift` |
| `for_each`/`count`/`dynamic` over apply-time values (`TerraformIterator`) | Only synth-time loops; use `CfnCondition` or a custom resource for deploy-time cardinality |
| Any cloud, any provider (4,000+), including GCP, Kubernetes, GitHub, Datadog | AWS only (plus a few third-party CloudFormation registry types) |
| `moved`/`import`/`removed` blocks declared *in code* and applied by the engine | `cdk refactor` (unstable), `cdk import`, `cdk orphan` (unstable): CLI operations with mapping files |
| `precondition`/`postcondition`/`check` evaluated by the engine at plan/apply | `CfnRule` assertions (parameters only), custom resources, Hooks |
| `lifecycle.ignore_changes` per attribute | Nothing per attribute; drift is tolerated by not detecting it |
| `lifecycle.replace_triggered_by`, `create_before_destroy` | `UpdateReplacePolicy`; replacement is decided by the resource schema |
| `sensitive` marking that redacts plan output | `NoEcho` on parameters only; secrets must never be in the template |
| State surgery (`state mv/rm/pull/push`, `taint`) | None; the equivalent is orphan + import, or a manual `ContinueUpdateRollback` |
| HCL output (`--hcl`) for HCL-only reviewers and scanners | Templates are the output; YAML/JSON |
| `terraform test`, terratest, Sentinel, HCP Terraform run tasks | `integ-tests-alpha`, cdk-nag, Hooks |
| Workspaces / `-target` / `-parallelism` | `--exclusively`, `--concurrency` (stack-level only) |
| Provider-defined functions (`provider::google::*`) | — |
| OpenTofu as a drop-in engine (`TERRAFORM_BINARY_NAME=tofu`) | One engine |

Neither has:

- A first-class notion of "environment promotion" (both leave it to pipelines and config).
- Automatic secret rotation; a database-migration primitive; a way to branch on deploy-time values in the program.
- A rename-safe identity that survives moving code between repositories; identity is a path (CDK) or a path/state (CDKTF), never a UUID. Pulumi's `aliases` and Crossplane's `metadata.name` come closest.

## One resource, five dialects

The same intent — a versioned, labelled/tagged, non-public object store whose name is exported — so the shapes above are concrete. Names follow `shared/src/naming.ts` (`resourceName`).

```ts
// AWS CDK (aws-cdk-lib 2.269.0)
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
export class StoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { tier: EnvironmentTier }) {
    super(scope, id, props);
    const bucket = new s3.Bucket(this, 'Store', {
      bucketName: resourceName({ org: 'cdkm', service: 'orders', env: props.tier.name, component: 'store' }),
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,       // default anyway
      encryption: s3.BucketEncryption.KMS_MANAGED,
      removalPolicy: props.tier.retainStatefulResources ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(bucket).add('environment', props.tier.name);
    new cdk.CfnOutput(this, 'StoreName', { value: bucket.bucketName, exportName: `${id}-store-name` });
  }
}
```

```ts
// CDKTF (cdktf 0.21.0, @cdktf/provider-google 16.12.1)
import { TerraformStack, TerraformOutput, GcsBackend } from 'cdktf';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
export class StoreStack extends TerraformStack {
  constructor(scope: Construct, id: string, props: { tier: EnvironmentTier; projectId: string; region: string }) {
    super(scope, id);
    new GoogleProvider(this, 'google', { project: props.projectId, region: props.region });
    new GcsBackend(this, { bucket: `${props.projectId}-tfstate`, prefix: `orders/${id}` });
    const bucket = new StorageBucket(this, 'store', {
      name: resourceName({ org: 'cdkm', service: 'orders', env: props.tier.name, component: 'store' }),
      location: props.region.toUpperCase(),
      uniformBucketLevelAccess: true,
      publicAccessPrevention: 'enforced',
      versioning: { enabled: true },
      labels: { environment: normaliseLabelValue(props.tier.name) },
      forceDestroy: !props.tier.retainStatefulResources,
      lifecycle: { preventDestroy: props.tier.retainStatefulResources },
    });
    new TerraformOutput(this, 'store_name', { value: bucket.name });
  }
}
```

```hcl
# Terraform HCL
terraform { backend "gcs" { bucket = "platform-prod-tfstate"  prefix = "orders/prod" } }
provider "google" { project = var.project_id  region = var.region }
resource "google_storage_bucket" "store" {
  name                        = "cdkm-orders-${var.env}-store"
  location                    = upper(var.region)
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = true }
  labels = { environment = var.env }
  force_destroy = !var.retain
  lifecycle { prevent_destroy = true }   # cannot be an expression
}
output "store_name" { value = google_storage_bucket.store.name }
```

```yaml
# CloudFormation
Resources:
  Store:
    Type: AWS::S3::Bucket
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      BucketName: !Sub cdkm-orders-${Env}-store
      VersioningConfiguration: { Status: Enabled }
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }
      BucketEncryption: { ServerSideEncryptionConfiguration: [ { ServerSideEncryptionByDefault: { SSEAlgorithm: aws:kms } } ] }
      Tags: [ { Key: environment, Value: !Ref Env } ]
Outputs:
  StoreName: { Value: !Ref Store, Export: { Name: !Sub "${AWS::StackName}-store-name" } }
```

```ts
// Pulumi (for orientation)
const bucket = new gcp.storage.Bucket('store', {
  name: `cdkm-orders-${env}-store`, location: region.toUpperCase(),
  uniformBucketLevelAccess: true, publicAccessPrevention: 'enforced',
  versioning: { enabled: true }, labels: { environment: env },
}, { protect: retain });
export const storeName = bucket.name;      // Output<string>
```

What to notice: the AWS CDK version is the only one where "non-public" and "encrypted" are defaults the author could have omitted; the CDKTF and HCL versions are the same statements in two syntaxes (the binding adds nothing); `prevent_destroy` is a literal in HCL but a prop in CDKTF because the *program* decides it before the engine sees the file; Pulumi's `protect` is an engine-side option like CDKTF's, and its `name` is an `Output` you cannot `.toUpperCase()` any more than a token.
