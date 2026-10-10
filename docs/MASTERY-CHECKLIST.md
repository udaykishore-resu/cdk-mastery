# Mastery Checklist

> "You are a master when you can…" — every item is something you can *do* or *explain from memory with the failure mode*, not a feeling. Tick honestly. Items reference the module that teaches them (`A` = `aws-cdk/`, `B` = `cdktf-gcp/`) and the [MASTERY-GUIDE](MASTERY-GUIDE.md) chapter with the theory. The [INTERVIEW-QA](INTERVIEW-QA.md) is the oral exam for the same material.

## 00 — Introduction ([A00](../aws-cdk/src/modules/00-introduction/README.md) · [B00](../cdktf-gcp/src/modules/00-introduction/README.md))

- [ ] Draw `App → Stack → Construct → L1` for CDK and `App → TerraformStack → Construct → Resource` for CDKTF and say which node is the `constructs` substrate and which is framework code.
- [ ] Recite the AWS CDK synthesis order (construct → aspects → reference resolution → validate → synthesize) and say at which phase a `Lazy` first runs and why `Lazy.uncachedString` exists.
- [ ] Name every file in `cdk.out/` and every file in `cdktf.out/stacks/<id>/` and say which are safe to delete.
- [ ] List what `cdk bootstrap` creates (bucket, ECR, 5 roles, SSM version — v32 in CLI 2.1141) and which CLI features need which minimum version.
- [ ] Explain why `app.synth()` is required in CDKTF and implicit under the CDK CLI, and what `cdktf synth --hcl` is for.
- [ ] Point CDKTF at OpenTofu without changing code.
- [ ] State the CLI/library version-split rule for AWS CDK (independent since CLI 2.1000.0, 2025-02) and the "same minor" rule for `cdktf`/`cdktf-cli`/providers.

## 01 — Constructs, logical IDs, tokens ([A01](../aws-cdk/src/modules/01-constructs-and-tokens/README.md) · [B01](../cdktf-gcp/src/modules/01-providers-resources-and-tokens/README.md))

- [ ] Compute a logical ID / Terraform address by hand from a construct path (both hashing rules, `Resource`/`Default` treatment, the top-level special case).
- [ ] Explain why `token.length`, `if (token)`, `JSON.stringify(token)` and `Map<token, …>` are bugs, and show the correct alternative for each in both frameworks.
- [ ] Choose L1/L2/L3 for a given need and say what a CDKTF binding does and does not do compared to an L2.
- [ ] Write a `for_each` with `TerraformIterator.fromMap` keyed on a stable key and explain why keying on an index is a replacement bomb.
- [ ] Use `Fn.*` in both, `propertyAccess`/`conditional`/`Op` in CDKTF, and `call()` for a function the typings lack.
- [ ] Configure a `google-beta` alias and pass it to one resource.
- [ ] Generate provider bindings locally (`cdktf provider add … --force-local`) and explain why prebuilt packages stopped at `cdktf` 0.21.

## 02 — Stacks, environments, references ([A02](../aws-cdk/src/modules/02-stacks-environments-and-references/README.md) · [B02](../cdktf-gcp/src/modules/02-state-backends-and-environments/README.md))

- [ ] Un-wire a strong cross-stack reference without hitting "export in use", and migrate strong → weak (`both` → `weak`) with the 2.254.0 flag.
- [ ] Explain what CDKTF generates for a cross-stack reference and why the consumer's identity can read every secret in the producer's state.
- [ ] Move CDKTF state from local to GCS with `--migrate-state`, and explain the lock and recovery model of the GCS backend.
- [ ] Say when an env-agnostic CDK stack is acceptable and list four things that break in one.
- [ ] Decide nested stack vs separate stack vs Terraform module vs separate CDKTF stack for a given blast-radius requirement.
- [ ] Explain context lookups vs data sources (when resolved, where cached, what CI needs).
- [ ] Split an app into layers by rate of change and say which layer holds stateful resources and why.

## 03 — Networking and compute ([A03](../aws-cdk/src/modules/03-networking-and-containers/README.md) · [B03](../cdktf-gcp/src/modules/03-networking-and-compute/README.md))

- [ ] Build a cost-aware VPC (NAT count, endpoints) and explain the `connections` API's effect on security-group placement across stacks.
- [ ] Deploy Fargate via the L3 pattern and by hand, and say when the pattern becomes the wrong choice.
- [ ] Build a custom-mode VPC with Cloud NAT and Private Service Access, with correct create/destroy ordering for Cloud SQL private IP.
- [ ] Wire Cloud Run v2 to a VPC with the right egress setting and a least-privilege service account, and decide who owns the container image (Terraform or CI) with the matching `ignore_changes`.

## 04 — Serverless and events ([A04](../aws-cdk/src/modules/04-serverless-and-events/README.md) · [B04](../cdktf-gcp/src/modules/04-serverless-and-events/README.md))

- [ ] Explain the asset pipeline end to end (hash, staging, `cdk-assets`, bootstrap bucket, template reference) and why an unchanged asset is a no-op.
- [ ] Bundle with esbuild locally and know when Docker is required; fix a non-deterministic asset hash.
- [ ] Wire `TerraformAsset` → `StorageBucketObject` → Cloud Functions gen2 so a code change redeploys the function.
- [ ] Explain `iam_member` vs `iam_binding` vs `iam_policy` and pick the right one for a Pub/Sub push subscription's invoker.
- [ ] Order API enablement and IAM eventual consistency correctly (`dependsOn`, `time_sleep`, `disableOnDestroy: false`).
- [ ] Canary-deploy a Lambda alias with CodeDeploy and explain what `--hotswap` would do instead and why it is dev-only.

## 05 — Constructs and libraries ([A05](../aws-cdk/src/modules/05-custom-constructs/README.md) · [B05](../cdktf-gcp/src/modules/05-constructs-and-modules/README.md))

- [ ] Design an L3 with `Props`, defaults, validation, `IXxx`, `fromXxxAttributes`, `grant*`, `metric*`, and explain why each exists.
- [ ] List five jsii constraints and say which apply even if you only ship TypeScript.
- [ ] Write a CDKTF construct that accepts `provider` and `dependsOn` and exposes its resources for `importFrom`/`moveTo`.
- [ ] Consume a registry module via `TerraformHclModule` and via generated bindings, and say what you lose with each.
- [ ] Set up a projen construct library with `peerDependencies` and explain what breaks when `aws-cdk-lib` is a `dependency`.
- [ ] Version a construct library so that identity changes are only possible in a major, with a migration recipe.

## 06 — Aspects, tags/labels, governance ([A06](../aws-cdk/src/modules/06-aspects-tags-and-governance/README.md) · [B06](../cdktf-gcp/src/modules/06-aspects-labels-and-governance/README.md))

- [ ] Write a mutating and a read-only aspect in both frameworks; assign priorities in CDK and order registration in CDKTF; explain the stabilisation loop.
- [ ] Hand the same `ConstructPolicy` from `shared/` to both `Aspects.of(...)` and show it works.
- [ ] Wire cdk-nag 3 via `Validations`, acknowledge a per-finding id with a reason, and produce the audit trail auditors want.
- [ ] Apply a permissions boundary to every role in a Stage and explain why an aspect alone is not a control.
- [ ] Write a labelling aspect that survives resources without `labels`, data sources and providers.
- [ ] Enforce a rule with conftest on `cdk.tf.json` and with an `OrgPolicyPolicy`; say which is preventive.
- [ ] Explain `explicitStackTags` and `aspectPrioritiesMutating` and what changed with each.

## 07 — Testing ([A07](../aws-cdk/src/modules/07-testing/README.md) · [B07](../cdktf-gcp/src/modules/07-testing/README.md))

- [ ] Use `Template`, `Match` (all matchers), `Capture` and `Annotations` fluently; know which matchers are partial and which are exact.
- [ ] Use `Testing.synth/synthScope/fullSynth` and every jest matcher; know the top-level-subset rule and when to parse the JSON.
- [ ] Write an identity test (logical IDs / addresses) and explain why it is the most important test in a library.
- [ ] Say when a snapshot helps and when it hurts, and how to strip volatile values.
- [ ] Gate `toBeValidTerraform`/`toPlanSuccessfully` so `npm test` runs without a binary or credentials.
- [ ] Test a construct inside a `Stage` and a CDKTF stack for both `dev` and `prod` tiers.

## 08 — Delivery ([A08](../aws-cdk/src/modules/08-pipelines-and-cicd/README.md) · [B08](../cdktf-gcp/src/modules/08-cicd-and-workload-identity/README.md))

- [ ] Build a self-mutating `CodePipeline` with waves and approval, and explain the failure mode of self-mutation.
- [ ] Deploy from GitHub Actions with OIDC using only the bootstrap roles, with a plan identity separate from a deploy identity.
- [ ] Set up Workload Identity Federation with attribute conditions for plan and apply SAs, and forbid SA keys by org policy.
- [ ] Post `cdk diff --change-set` / `cdktf diff` on PRs; explain why the CDKTF PR plan is advisory and how to make plan = apply.
- [ ] Schedule drift detection on both clouds and route findings to owners.
- [ ] Run a framework/provider upgrade train whose review artefact is the aggregated diff.

## 09 — Organisation scale ([A09](../aws-cdk/src/modules/09-multi-account-and-multi-region/README.md) · [B09](../cdktf-gcp/src/modules/09-multi-project-and-org-scale/README.md))

- [ ] Model `Stage × Environment` from `shared/ENVIRONMENTS` and bootstrap with trust, qualifier and a custom boundary.
- [ ] Use `crossRegionReferences` for the ACM/CloudFront case and explain the custom resources it deploys.
- [ ] Manage feature flags deliberately (`cdk flags`, the manifest report) and explain what a library upgrade will and will not flip.
- [ ] Build a project factory that enables APIs in order, attaches to Shared VPC, and hardens default SAs.
- [ ] Lay out state buckets, prefixes, deploy SAs and WIF pools for N projects × 3 environments with least privilege on state reads.
- [ ] Use per-region provider aliases and stack dependencies so `cdktf deploy '*'` orders host before service projects.

## 10 — Escape hatches, custom logic, migration ([A10](../aws-cdk/src/modules/10-escape-hatches-custom-resources-and-migration/README.md) · [B10](../cdktf-gcp/src/modules/10-escape-hatches-hcl-migration-and-interop/README.md))

- [ ] Rank the escape hatches in both frameworks and pick the least invasive one for a given gap.
- [ ] Write a `Provider`-framework custom resource with `isComplete`, and an `AwsCustomResource`; list the two bugs everyone ships.
- [ ] Explain why CDKTF has no custom resources and pick between `terraform_data`+provisioner, `external`, provider-defined functions, a real provider, and "do it in CI".
- [ ] Lift a CloudFormation template with `CfnInclude` and replace one resource with an L2 at the same logical ID.
- [ ] `cdk import` a console-created resource and prove it with `cdk drift`.
- [ ] Use `cdk refactor --unstable=refactor --dry-run` and `cdk orphan` and say why they are still gated.
- [ ] Convert HCL with `cdktf convert`, reach an empty plan against the existing state, and cut over with rollback.
- [ ] Emit `import` and `moved` blocks from code (`importFrom`, `moveTo`/`moveToId`) and know their Terraform version requirements.
- [ ] Explain why CDK ↔ CDKTF is a re-platform and what survives (the `constructs`-only code).

## 11 — Capstones ([A11](../aws-cdk/src/modules/11-capstone-platform/README.md) · [B11](../cdktf-gcp/src/modules/11-capstone-platform/README.md))

- [ ] Ship both Orders platforms (dev + prod, multi-stack, governed, tested, pipelined) and explain every decision in each README in under ten minutes.
- [ ] Describe the monorepo layout, ownership, versioning, release train and on-call model you would use for 200 engineers on both clouds ([MASTERY-GUIDE](MASTERY-GUIDE.md) chapter 11).
- [ ] Roll a breaking construct change across many stacks with an identity mapping and a deprecation window.
- [ ] Narrate exactly what happens when `cdk deploy` and `cdktf deploy` fail halfway, and recover both.
- [ ] Recover a corrupted or lost `tfstate` and an `UPDATE_ROLLBACK_FAILED` stack.
- [ ] Argue the [DECISION-MATRIX](DECISION-MATRIX.md) for each archetype and disagree with the author's "what I would do" with reasons.

## Prove it: five projects, from scratch, without looking at this repo

1. **The two-cloud environment model.** A `constructs`-only package with an environment model, naming, label/tag normalisers and a policy walker; an AWS CDK app and a CDKTF app that both consume it, each with a stack per tier, mandatory tags/labels enforced by the shared walker, and tests that fail when a tag is missing. Acceptance: both `npm test` suites pass without credentials; a deliberately mistagged resource fails synth in both.

2. **The ClickOps rescue.** Given a console-created S3 bucket + DynamoDB table + Lambda (AWS) and a GCS bucket + Pub/Sub topic + Cloud Function (GCP), bring all six under management without downtime: `cdk import` with a recorded mapping and `cdk drift` proof; `importFrom` with an empty plan afterwards. Then rename every construct once and prove zero replacements (`overrideLogicalId`/`cdk refactor --dry-run`; `moved` blocks).

3. **Keyless delivery.** GitHub Actions: plan-on-PR and deploy-on-main for both apps with OIDC (bootstrap roles only) and WIF (separate plan/apply SAs, attribute conditions), a concurrency group per environment, plan artefact equals applied artefact on GCP (Terraform driven from `cdktf.out`), and a nightly drift job that opens an issue with the diff. Acceptance: a PR from a fork cannot reach the apply identity; a manual console change is reported within 24 h.

4. **The governed construct library.** A projen-built, jsii-compliant library with one L3 (an "ObjectStore with lifecycle, CMEK and access logging") for AWS and one CDKTF construct for GCP, each with `IXxx`, importers, `grant*`-style helpers, validation, README, changelog, an identity snapshot test, and a canary app whose `diff` runs in the library's CI. Release a minor that changes a default behind a flag; document the migration; then a major that changes identity with a mapping recipe.

5. **The migration.** Take a 30-resource CloudFormation stack and a 30-resource HCL root module (write them if you must). Migrate the first to CDK via `CfnInclude` and progressive L2 replacement, and the second to CDKTF via `cdktf convert`, reaching zero-change diffs before any behavioural change; then move three stateful resources between stacks in each (orphan + import; `state mv` + `moved`). Write the risk table and the rollback you executed at least once on purpose.

When all five are done and the boxes above are ticked, you are the person others come to. Keep the [GOTCHAS](GOTCHAS.md) file growing; that is what the role is.
