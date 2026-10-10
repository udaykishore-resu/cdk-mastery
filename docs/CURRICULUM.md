# Curriculum

Two tracks, twelve modules each, one shared library, one capstone per track. Modules are numbered identically across the tracks on purpose: **module `NN` in the AWS CDK track teaches the same *idea* as module `NN` in the CDKTF track**, so you can read them side by side and see where the frameworks agree (the construct tree, aspects, tokens, testing) and where the underlying engines force them apart (CloudFormation's managed state vs. Terraform's state file, `cdk bootstrap` vs. backends, custom resources vs. providers).

Every module ships four things: a `README.md` that teaches, a `src/modules/NN-slug/` folder of runnable code, a `test/NN-slug.test.ts` file that proves the code does what the README claims, and an `exercises` section with solutions in the same module. Nothing is a stub.

## Pinned versions

| Package | Version | Why it matters |
|---|---|---|
| `aws-cdk-lib` | 2.269.0 | The construct library. Versioned separately from the CLI since 2024. |
| `aws-cdk` (CLI) | 2.1141.x | The CLI has its own release train (2.1000+); it is backwards compatible with older `aws-cdk-lib`. |
| `constructs` | 10.8.x | The shared tree substrate for **both** frameworks. |
| `cdk-nag` | 3.0.x | Policy-as-code rule packs for AWS CDK. |
| `cdktf` | 0.21.0 | CDK for Terraform core. |
| `cdktf-cli` | 0.21.0 | Must match `cdktf` minor. |
| `@cdktf/provider-google` / `-google-beta` | 16.12.x | Prebuilt (jsii) bindings; each major tracks a cdktf minor. |
| `@cdktf/provider-random` | 12.0.x | For suffixes and passwords. |
| `typescript` | 5.9.x | jsii-based libraries are not yet validated against TypeScript 7. |
| `jest` / `ts-jest` | 29.x | Both frameworks ship jest matchers. |

Node 20+ is required. Terraform (or OpenTofu) ≥ 1.9 is only needed for `cdktf diff/deploy` and the gated `toBeValidTerraform` tests; every module synthesizes and every test passes **without** cloud credentials, a Terraform binary, or Docker.

## Track A — AWS CDK (`aws-cdk/`)

| # | Module | You will be able to… |
|---|---|---|
| 00 | Introduction: from CloudFormation to the construct tree | Explain `App → Stack → Construct`, the synth lifecycle (construct → prepare → validate → synthesize), and every file in `cdk.out`; know what `cdk bootstrap` actually creates. |
| 01 | Constructs, logical IDs & tokens | Choose between L1/L2/L3; predict a logical ID from a construct path; use `Lazy`, `Fn`, `Token.isUnresolved`; know why `token.length` is a bug. |
| 02 | Stacks, environments & references | Split an app into stacks safely; wire cross-stack references (and un-wire them without a deadlock); use SSM for decoupled sharing; nested stacks; context lookups and why `cdk.context.json` is committed. |
| 03 | Networking & containers | Build a cost-aware VPC; use the `connections` API; deploy an ECS Fargate service both with the L3 pattern and by hand, and know when each is right. |
| 04 | Serverless & event-driven | Wire HTTP API → Lambda → DynamoDB, EventBridge → SQS → worker, and a Step Functions saga with least-privilege `grant*` calls; bundle with esbuild; canary-deploy a Lambda alias. |
| 05 | Custom constructs & construct libraries | Design an L3 construct with a props interface, defaults, validation, `IXxx` + `fromXxxAttributes`, `grant*` and `metric*` APIs; know the jsii rules for publishing. |
| 06 | Aspects, tags & governance | Write mutating and read-only aspects; apply `Tags`; fail synth with `Annotations`; run `cdk-nag` and suppress with justification; apply permission boundaries app-wide. |
| 07 | Testing | Use `Template`, `Match`, `Capture`, `Annotations`; decide when snapshots help and when they hurt; test constructs in isolation and stacks inside a `Stage`. |
| 08 | Pipelines & CI/CD | Build a self-mutating `CodePipeline` with stages, waves, and approval gates; alternatively deploy from GitHub Actions via OIDC with `cdk diff` on PRs. |
| 09 | Multi-account & multi-region | Model environments as `Stage × Environment`; customise the synthesizer/qualifier; use `crossRegionReferences`; manage feature flags; drive everything from one config. |
| 10 | Escape hatches, custom resources & migration | Override any CFN property; adopt legacy templates with `cloudformation-include`; `cdk import` existing resources; write a `Provider`-framework custom resource and an `AwsCustomResource`. |
| 11 | Capstone: the Orders platform | Ship a dev + prod, multi-stack, governed, tested, pipelined platform and explain every decision in it. |

## Track B — CDK for Terraform on GCP (`cdktf-gcp/`)

| # | Module | You will be able to… |
|---|---|---|
| 00 | Introduction: Terraform core, CDKTF & the synth → plan → apply loop | Explain `App → TerraformStack → Construct`, what `cdktf synth` writes, how prebuilt providers differ from `cdktf get`, and how to point CDKTF at OpenTofu. |
| 01 | Providers, resources, data sources & tokens | Configure the Google provider (and a `google-beta` alias); use variables/outputs/locals; `dependsOn`, `lifecycle`; `count`/`for_each` with `TerraformIterator`; know why `Token.asString` exists. |
| 02 | State, backends & environments | Move state to GCS; consume remote state; wire cross-stack references and understand the deploy-order they impose; stack-per-env vs workspaces; state surgery with `moveTo` and `importFrom`. |
| 03 | Networking & compute | Build a custom-mode VPC with Cloud NAT and Private Service Access; deploy Cloud Run v2 with VPC egress and a private Cloud SQL instance; least-privilege service accounts. |
| 04 | Serverless & events | Wire Pub/Sub (with DLQ), Cloud Functions gen2 from a `TerraformAsset`, Eventarc, Cloud Scheduler, BigQuery; know the `iam_member` vs `iam_binding` vs `iam_policy` trap. |
| 05 | Constructs & modules | Write reusable CDKTF constructs with validation; consume Terraform Registry modules (`TerraformHclModule` and generated bindings); package with jsii/projen. |
| 06 | Aspects, labels & governance | Label every resource with one aspect; block public buckets and require CMEK with validating aspects; use `precondition`/`postcondition`; enforce policy on `cdk.tf.json` with conftest and on the org with `OrgPolicyPolicy`. |
| 07 | Testing | Use `Testing.synth`, `toHaveResourceWithProperties`, snapshot tests, and gated `toBeValidTerraform`/`toPlanSuccessfully`; test constructs and aspects in isolation. |
| 08 | CI/CD & Workload Identity Federation | Deploy from GitHub Actions with no long-lived keys; post plans on PRs; detect drift on a schedule; use HCP Terraform as a backend. |
| 09 | Multi-project & org scale | Build a project factory; Shared VPC host/service projects; folder-level IAM and org policies; per-region provider aliases; stack-per-project with dependencies. |
| 10 | Escape hatches, HCL migration & interop | `addOverride`, raw `TerraformResource`; `cdktf convert` HCL → TS; `importFrom` and `moveTo` refactors; `cdktf synth --hcl` for HCL-only teams; use community providers via `cdktf get`. |
| 11 | Capstone: the Orders platform on GCP | Ship a dev + prod, multi-stack, labelled, governed, tested, WIF-pipelined platform and explain every decision in it. |

## Shared library (`shared/`)

`@cdk-mastery/shared` depends only on `constructs`. It holds the environment model (`ENVIRONMENTS`), the naming convention (`resourceName`, `regionShortCode`), the label/tag normalisers, and a framework-agnostic `ConstructPolicy` walker that both tracks plug into their `Aspects`. Both capstones import it; that is the concrete demonstration that the construct tree, not the cloud, is the abstraction.

## Reading order

1. Track A modules 00–02, then Track B modules 00–02 — the mental models diverge here, and seeing both early prevents confusion later.
2. Then alternate module by module (A03, B03, A04, B04, …).
3. Read [`ROSETTA-STONE.md`](ROSETTA-STONE.md) after module 05 and again after module 10.
4. Do both capstones. Then take the [`MASTERY-CHECKLIST.md`](MASTERY-CHECKLIST.md) honestly.
