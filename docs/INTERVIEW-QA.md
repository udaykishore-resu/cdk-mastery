# Interview Q&A: Staff / Principal level

> Model answers are deliberately short: the point you must land, the trade-off, and the failure mode. Interviewers at this level are listening for *why*, for version awareness, and for what you would refuse to do. Cross-reference: [MASTERY-GUIDE](MASTERY-GUIDE.md) for depth, [GOTCHAS](GOTCHAS.md) for the war stories, [MASTERY-CHECKLIST](MASTERY-CHECKLIST.md) to see which of these you cannot yet answer from memory.

Versions assumed: `aws-cdk-lib` 2.269.0 / CLI 2.1141.0; `cdktf` 0.21.0; Terraform/OpenTofu ≥ 1.9; `hashicorp/google` 6.50.0.

---

## Part A — AWS CDK

**A1. What exactly happens between `new App()` and a CloudFormation `CreateChangeSet` call?**
Constructors build a tree (`constructs`); `app.synth()` runs aspects (by priority, with a stabilisation loop), resolves cross-stack references by rendering every L1 once, runs validations, then renders each stack's template plus asset manifests into `cdk.out` (schema 54.x) and runs `Validations` plugins. The CLI reads `manifest.json`, publishes assets with `cdk-assets` (content-hashed into the bootstrap bucket/ECR via the publishing roles), assumes the deploy role, and calls `CreateChangeSet` with the cfn-exec role and the template's S3 URL. Trade-off: the program runs on your machine, so synthesis must be pure; anything that depends on who ran it (credentials, `Date.now()`) is a defect.

**A2. Why does renaming a construct replace a resource, and what are your three tools to avoid it?**
Logical ID = human-readable path components + 8 hex of MD5 of the full path; a new path is a new identity, and CloudFormation implements identity change as delete+create. Tools: `overrideLogicalId`/`renameLogicalId` (keep the old ID), `cdk refactor --unstable=refactor` (compute and apply the mapping via CloudFormation's refactor API; still unstable in CLI 2.1141), and `RemovalPolicy.RETAIN` + `cdk import` as the safety net. The trade-off of `overrideLogicalId` is a permanent scar in the code; of `refactor`, that it forbids any other change in the same operation.

**A3. What is a token, and name three operations that silently break on one.**
A placeholder (`${Token[TOKEN.n]}`, a magic negative number, a one-element magic list) resolved at synth to an intrinsic. Breakers: `.length`/`substring` (operate on the placeholder), `===`/`if` (always truthy, never equal), `JSON.stringify` (no resolution — use `stack.toJsonString`). `Token.isUnresolved` is the guard; `Lazy` is for values known only after all constructors ran; cached `Lazy.string` is frozen at the prepare phase, `uncachedString` re-runs.

**A4. Strong versus weak cross-stack references: when would you choose each?**
Strong (default): `Export`/`Fn::ImportValue`; CloudFormation refuses to delete or change a value in use — safe, but produces the "export in use" deadlock when you un-wire (fix: `exportValue` for one deploy). Weak (2.254.0+, flag `defaultCrossStackReferences: "weak"`, renders `Fn::GetStackOutput`): no export, no deadlock, but the producer can change under the consumer, which then fails at its next update or at runtime. Choose strong for foundational values (VPC, KMS keys), weak for high-churn app-to-app wiring where independent deploys matter more than enforcement; migrate strong → weak through `"both"`.

**A5. Env-agnostic stacks: when are they acceptable?**
Only for samples and single-account dev sandboxes. They cannot do lookups, cannot use `crossRegionReferences`, return two fake AZs, and make the synthesized artefact depend on the deployer's credentials. Production: `env` from the environment model, `Stage × Environment`, `--lookups=false` in CI with `cdk.context.json` committed.

**A6. Explain the bootstrap stack and why it is the security boundary.**
`cdk bootstrap` creates, per (account, region, qualifier): an S3 asset bucket, an ECR repo, five roles (file/image publishing, lookup, deploy, cfn-exec) and an SSM version parameter (v32 with CLI 2.1141). Templates assert the version via a `Rules` block. Whoever can assume the deploy role can deploy anything the cfn-exec role can create — by default `AdministratorAccess`. Harden with `--cloudformation-execution-policies`, `--custom-permissions-boundary` (applied to every role CDK creates via `PermissionsBoundary.fromName` on the Stage), `--trust` only for the pipeline account, and a qualifier per platform generation.

**A7. When do you reach for L1, L2, L3, and when do you write your own construct?**
L3 to start fast when the pattern matches exactly and you accept its opinions; L2 for everything routine (defaults, `grant*`, `metric*`, `connections`); L1 when the L2 does not expose a property, when the resource is new, or when you are lifting a legacy template (`CfnInclude`). Write a construct when the same three L2s are wired the same way in more than two places, or when you need to encode an organisational rule (naming, labels, retention) once. Never write a construct that re-exports `aws-cdk-lib` types under new names.

**A8. How do aspects interact with each other since 2.172.0, and what did `aspectPrioritiesMutating` change?**
Aspects have priorities (`MUTATING` 200 < `DEFAULT` 500 < `READONLY` 1000); lower runs first; ties are unordered; a stabilisation loop re-walks the tree while aspects add nodes/aspects. Before, one pass, closest-to-target last. `aspectPrioritiesMutating` (2.189.1) makes the library's own aspects (Tags, removal policies) run at MUTATING so your default-priority aspects run after them and win. Failure mode: two `DEFAULT` aspects setting the same property flip-flop between builds.

**A9. How would you enforce "every IAM role has a permissions boundary" for 300 stacks?**
Not with an aspect alone. Bootstrap every environment with `--custom-permissions-boundary`, set `PermissionsBoundary.fromName()` on every `Stage`, and put an IAM condition in the cfn-exec role's policy (`iam:PermissionsBoundary` must equal the ARN) so a stack that omits it fails at deploy; add an SCP for the same condition so console users cannot bypass either. The aspect (or cdk-nag) is the developer-feedback layer, not the control.

**A10. cdk-nag 3 changed its API. What is different and how do you suppress a finding with an audit trail?**
3.0.0 (2026-06) rides on core `Validations`: `Validations.of(app).addPlugins(new AwsSolutionsChecks(app))`; suppress with `Validations.of(construct).acknowledge({ id: 'AwsSolutions-IAM5[Action::s3:*]', reason })` (per-finding ids replace `appliesTo`); findings land in `validation-report.json`; `writeSuppressionsToCloudFormation: true` keeps the `cdk_nag` metadata for auditors reading templates. Raw `addPropertyOverride` fixes are invisible to rules, so remediate via the typed L1 and acknowledge with a reason.

**A11. What does `cdk deploy --hotswap` actually do and why is it banned in your prod pipeline?**
It detects changes limited to Lambda code/config, ECS task definitions, Step Functions definitions, etc., and applies them with direct API calls, skipping CloudFormation. Fast dev loop; but the stack template no longer matches reality (drift), the change is not audited as a stack event, and a subsequent real deploy may not "fix" it if the hash did not change. `--hotswap-fallback` degrades to a full deploy when needed; still dev-only.

**A12. `UPDATE_ROLLBACK_FAILED`: walk me through recovery.**
Identify the resource(s) that failed to roll back (events). `cdk rollback --orphan <LogicalId>` (bootstrap ≥ 23) or `aws cloudformation continue-update-rollback --resources-to-skip`; the skipped resource stays as-is and its logical ID is now out of sync — fix by hand or `cdk import`. Then address the root cause (usually a custom resource `Delete` that throws, a non-empty bucket, or a dependency CloudFormation could not reverse) and redeploy. Prevention: idempotent custom resources, `RETAIN` on stateful things, `--no-rollback` in dev to inspect failures.

**A13. Why does `Vpc.fromLookup` require a concrete env and a committed `cdk.context.json`?**
Lookups call AWS at synth time with the lookup role and cache in `cdk.context.json`; without a concrete account/region there is nothing to query. CI must be deterministic, so the cache is committed and `--lookups=false` guards against accidental live calls. Stale cache is the failure: `cdk context --reset`.

**A14. Custom resource: `Provider` framework versus `AwsCustomResource`. When each, and the two bugs everyone ships?**
`AwsCustomResource` for one SDK call per lifecycle event (no code, `fromSdkCalls` policy, `getResponseField`); `Provider` when you need a real lifecycle, async completion (`isCompleteHandler`, `totalTimeout`), or logic. Bugs: a `Delete` handler that fails when the resource was never created (blocks stack deletion and rollback), and a physical ID that changes on update (CloudFormation then deletes the "old" one). Also: `installLatestAwsSdk` defaults off; `logApiResponseData` can leak secrets.

**A15. How do assets get from a laptop to a Lambda in `ap-southeast-2`, and why is the hash in the S3 key?**
Bundling (esbuild/Docker) → staged into `cdk.out/asset.<sha256>` → `.assets.json` lists destinations → `cdk-assets` assumes the file-publishing role and uploads to `cdk-<q>-assets-<acct>-<region>` under the hash → the template references bucket+key. Content-addressed keys make unchanged code a no-op and changed code a resource update; the cost is a bucket that grows forever (`cdk gc --unstable=gc`). Docker image assets follow the same path into ECR.

**A16. Self-mutating pipelines: what does "self-mutate" mean and what is the failure mode?**
The pipeline's first stages synth the app and then `cdk deploy` the pipeline stack itself, so a change to the pipeline definition applies before later stages run. Failure mode: a broken pipeline definition can only be fixed by a manual `cdk deploy PipelineStack` from a laptop; also, a self-mutation that adds a stage requires a second run to execute it. Trade-off versus GHA+OIDC: CodePipeline is slower to iterate and cross-region needs replication buckets, but the assembly-once/deploy-everywhere model and cross-account trust are built in.

**A17. Multi-region: how do you get an ACM certificate in `us-east-1` into a CloudFront stack in `eu-west-1`?**
Two stacks with explicit envs and `crossRegionReferences: true`; CDK deploys an ExportWriter custom resource in `us-east-1` that writes the ARN to SSM in `eu-west-1`, and an ExportReader that resolves it; adds a dependency. Costs a Lambda-backed custom resource and a few minutes; needs bootstrap ≥ 8. Alternative: `DnsValidatedCertificate` is deprecated; use the `certificatemanager.Certificate` in a `us-east-1` stack plus cross-region refs, or hand-share via SSM.

**A18. What is `TableV2`, and why does migrating to it require `cdk orphan`?**
`TableV2` (2.95.0+) renders `AWS::DynamoDB::GlobalTable` with first-class replicas, billing per replica, and the newer API; `Table` renders `AWS::DynamoDB::Table`. CloudFormation cannot change a resource's type in place, so the documented path is orphan (`DeletionPolicy: Retain`, remove from template, rewrite references) → change code → `cdk import --resource-mapping-inline`. Zero downtime; still requires the imported properties to match reality (run `cdk drift` afterwards).

**A19. How do you test a construct library so that a change cannot silently replace consumers' resources?**
A test that instantiates the construct in a throwaway stack and snapshots `Object.keys(template.Resources)` plus resource types (identity), separate from property assertions (`hasResourceProperties`, `Match.*`, `Capture`). Negative tests for validation. Test in a `Stage` when behaviour depends on env. Publish a changelog naming logical-ID impact, and run the consumer canary app's `cdk diff` in the library's CI.

**A20. What changed with the CLI/library split, and how do you pin?**
Since CLI 2.1000.0 (2025-02-18) `aws-cdk` releases independently of `aws-cdk-lib`; the CLI is backwards compatible with older libraries and refuses newer cloud-assembly schemas. Pin both exactly; bump the CLI first (safe), the library second (reviewed diff). `cdk --version` and `cdk.out/cdk.out` (`{"version":"54.x"}`) tell you the schema.

**A21. `cdk deploy --method direct` versus change sets: when is direct acceptable?**
Direct calls `UpdateStack` without a change set — faster, no preview, no per-resource progress, no CAB artefact. Acceptable in dev sandboxes and for hotfix speed where the diff was reviewed elsewhere; forbidden where change sets are the control artefact. `prepare-change-set` + `execute-change-set` is how you split approval from execution.

**A22. Why is `Stack.of(this).availabilityZones` dangerous in an L3 you publish?**
In an env-agnostic stack it returns two placeholder AZs (`dummy1a`, `dummy1b`), and in a concrete env it triggers a context lookup. A published construct should accept `vpc`/subnets from the caller or expose `maxAzs` and document the lookup; hiding a lookup inside a library is how consumers get "no credentials" failures in CI.

---

## Part B — CDKTF and Terraform on GCP

**B1. What does CDKTF add to Terraform, and what does it not add?**
Adds: a program (TypeScript etc.) that emits Terraform JSON/HCL, the `constructs` tree (composition, aspects, tests), typed bindings generated from provider schemas, `TerraformIterator` for `for_each`, `importFrom`/`moveTo` for `import`/`moved` blocks, remote-state wiring between stacks, `Testing` matchers. Does not add: any resource semantics (no L2, no defaults, no `grant*`), rollback, custom resources, or a different state model. The engine is unchanged; `--hcl` proves it.

**B2. Explain the synth → plan → apply loop and where `cdktf` ends and `terraform` begins.**
`cdktf synth` runs your app with `CDKTF_OUTDIR`, invokes aspects, validates, writes `cdktf.out/stacks/<id>/cdk.tf.json` + `manifest.json`. `cdktf diff/deploy` then shells out to `terraform init/plan/apply` (or `tofu` via `TERRAFORM_BINARY_NAME`) inside each stack directory, in manifest dependency order. Everything after synth is plain Terraform: state, locks, providers, plan files. That is why the exit ramp is trivial and why `cdktf deploy` re-plans (the PR plan is advisory unless you apply a saved plan file yourself).

**B3. How is a Terraform address derived from a construct path, and how do you rename safely?**
Path components below the stack, `Default` dropped, `Resource` hidden from the human part, joined with `_`, plus 8 hex MD5 of the path; a single top-level component is used verbatim. Renaming/moving changes the address → destroy/create. Safe rename: `newResource.addMoveTarget('t')` + `old.moveTo('t')`, or `moveToId('type.old')`, both render `moved` blocks (Terraform ≥ 1.1); apply once, remove. Across state files: `terraform state mv -state-out`. `overrideLogicalId` pins an address permanently.

**B4. Cross-stack references in CDKTF: mechanism, and two security consequences.**
Using a token from stack A in stack B adds a `TerraformOutput` (sensitive) to A and a `DataTerraformRemoteState<Backend>` to B, plus a manifest dependency. Consequences: A needs a remote backend readable by B's identity, and B reads A's *entire* state (every secret in it) — `terraform_remote_state` cannot be scoped to one output. For sensitive producers, share through Secret Manager or data sources by name instead. There is no deadlock: deleting A's output just breaks B's next plan.

**B5. `iam_member` vs `iam_binding` vs `iam_policy`: define the semantics and the incident you have seen.**
Member: additive (one principal, one role). Binding: authoritative for that role — replaces every member of the role. Policy: authoritative for the whole resource policy — replaces everything, including service-agent bindings GCP needs. Classic incident: a `google_project_iam_binding` for `roles/editor` written by one team wiped the CI service account's editor binding managed by another; the next apply of the other team's stack put it back, and the two fought forever. Default to member; binding only when you own all members; policy as break-glass.

**B6. API enablement: why does the first apply fail and the second succeed, and what is the correct fix?**
`google_project_service` enables an API asynchronously and eventually consistently; resources of that API do not depend on it automatically. Fix: explicit `dependsOn` from resources (or the construct) to the `ProjectService`, enable `serviceusage`/`cloudresourcemanager` first, `time_sleep` for the slow ones, `disableOnDestroy: false` so destroying one stack does not disable APIs used by another. Retrying until green is not a fix; it is a race you will lose in the pipeline.

**B7. Which provider defaults protect you from destroying prod, and how does your environment model drive them?**
`SqlDatabaseInstance.deletionProtection` (true), `CloudRunV2Service.deletionProtection` (true, provider 6.x), `BigqueryTable.deletionProtection` (true), `Project.deletionPolicy` (`PREVENT`), `StorageBucket.forceDestroy` (false), `lifecycle.preventDestroy`. Drive them from `ENVIRONMENTS[tier].retainStatefulResources` via an aspect (module B06) so prod is protected and dev is disposable; know that flipping a protection and destroying must be two applies.

**B8. GCS backend: locking, encryption, and what "state is a secret" implies operationally.**
GCS locks with a lock object and generation preconditions (no extra service); `kmsEncryptionKey`/`encryptionKey` for CMEK/CSEK; object versioning is required for recovery. State contains every attribute the provider returns — passwords, keys, connection strings — so: uniform bucket-level access, no public, CMEK, audit logs, a writer SA per environment, `prevent_destroy` on the bucket, and remote-state readers limited to what they must read (see B4).

**B9. Recover a corrupted or lost tfstate.**
Stop all runs (lock; CI concurrency). If versioned: restore the previous object version, `terraform state pull` to verify serial/lineage, and re-plan — expect drift for anything applied after that version. If lost: rebuild by import — `resource.importFrom(id)` for each resource (or `terraform import` / `import` blocks with `-generate-config-out` for discovery), starting from stateless resources and moving to ones with dependants; use the cloud's inventory (Asset Inventory) to enumerate. If the file is *corrupt* (bad JSON, serial mismatch), `terraform state push -force` a fixed copy only after `terraform show` on the candidate passes. Post-incident: versioning, retention lock, and a state-backup job.

**B10. `for_each` versus a TypeScript loop: which do you use for "one subnet per region"?**
If the list is known at synth time (config), a TypeScript loop: each resource gets its own address, references are simple, and plans are readable. If the list is only known at apply time (a data source), `TerraformIterator.fromMap/fromComplexList` with a stable key — never an index, because inserting one element renumbers and replaces the rest. `count` only for on/off (`TerraformCount.of(cond ? 1 : 0)`).

**B11. Why is there no custom resource in CDKTF and what do you do for a schema migration?**
Terraform's only lifecycle implementer is a provider. Options: `DataResource` (`terraform_data`) + `local-exec` provisioner (not planned, not retried, runs on the CI runner), an `external` data source (read-only), a Cloud Run job executed by CI after apply (the honest answer for migrations), or writing a provider (right when the thing has state). Provider-defined functions (`provider::google::*`, Terraform 1.8+) are pure and cannot help here; `call()` renders them in 0.21.

**B12. Escape hatches: rank them.**
Typed prop → `resource.addOverride('path', v)` (JSON path; `lifecycle.ignore_changes`, block indexes `x.0.y`) → `overrideLogicalId` → raw `TerraformResource` for a type your bindings lack → regenerate bindings (`cdktf get` against a newer provider) → `TerraformHclModule` to call HCL you cannot type → `stack.addOverride` for `terraform`/`backend`/`removed` blocks → `--hcl` and hand the file to plain Terraform. Each step down is less reviewable and less testable.

**B13. HCL → CDKTF migration in three steps, with rollback.**
(1) `cdktf convert --stack < main.tf` (or `cdktf init --from-terraform-project`) and clean up types/expressions; (2) point the CDKTF stack at the **same backend and prefix**, `cdktf synth --hcl`, diff against the original HCL and run `cdktf diff` until the plan is empty (use `moved`/`overrideLogicalId` to match addresses); (3) cut over CI. Rollback at any step: the state was never changed; re-run the HCL. The only irreversible moment is the first apply with a non-empty plan.

**B14. What is the status of CDKTF as a project, and how does it change your recommendation?**
`cdktf` 0.21.0 released 2025-06-04, nothing since; HashiCorp archived all prebuilt provider packages on 2025-12-10 (last `@cdktf/provider-google` 16.12.1 targets provider 6.50.0 and only works with cdktf 0.21). Bindings must now be generated locally (`cdktf provider add hashicorp/google --force-local`). Recommendation: acceptable for stamping-heavy GCP programs if you keep the `--hcl` exit ramp and pin everything; not a platform-layer bet; re-evaluate against Pulumi/HCL every six months.

**B15. Terraform vs OpenTofu for a CDKTF project.**
CDKTF is engine-agnostic (`TERRAFORM_BINARY_NAME=tofu`); state formats are compatible at 1.5-era baselines but diverge with fork-only features (OpenTofu state encryption, provider `for_each`, OCI registries; Terraform ephemeral values, write-only attributes, `use_lockfile`). Pick per licence posture (BUSL if you embed Terraform in a product) and features; never apply one state with both engines; pin the version in `required_version` via `stack.addOverride`.

**B16. Plan-on-PR with WIF: how do you make sure a malicious PR cannot apply?**
Two service accounts (plan: viewer + state `objectViewer`; apply: real roles + `objectAdmin`), two WIF attribute conditions (`assertion.repository == 'org/repo'` and, for apply, `assertion.ref == 'refs/heads/main'` or the GitHub environment), no `pull_request_target` with secrets, GitHub environment with required reviewers on apply, a concurrency group per environment, org policy `iam.disableServiceAccountKeyCreation` so nobody falls back to keys. Post the plan as a comment, truncated and `--no-color`.

**B17. Drift on GCP: how is it detected, and what is `ignore_changes` for?**
Every plan refreshes state from the API, so drift shows as a diff; `cdktf diff --refresh-only` (or `plan -refresh-only -detailed-exitcode` on a schedule) is the drift job. `lifecycle.ignoreChanges` declares that another system owns an attribute (a CI-deployed Cloud Run image, auto-added labels). The failure mode is the inverse: someone adds `ignore_changes = all` to silence a diff and Terraform stops managing the resource in practice.

**B18. Project factory: what must it do beyond `google_project`?**
Billing account link; folder placement; `deletionPolicy`; API enablement with ordering; disable default network (`autoCreateNetwork: false`) or delete it; Shared VPC service attachment (`ComputeSharedVpcServiceProject`) and subnet IAM (`networkUser`); default service-account hardening (org policy `iam.automaticIamGrantsForDefaultServiceAccounts`); labels from the environment model; a WIF binding for that project's CI; optional budget alert. Output the project number, because many IAM principals need it, not the ID.

**B19. Shared VPC in code: which stack owns what?**
Host project stack: network, subnets, Cloud NAT, Private Service Access ranges, firewall policies, `ComputeSharedVpcHostProject`. Service project stack(s): `ComputeSharedVpcServiceProject`, `ComputeSubnetworkIamMember` for their service accounts, and their workloads referencing subnets by self-link via remote state or `DataGoogleComputeSubnetwork`. Dependency: service stacks depend on host; destroy order is reversed and blocked while attachments exist.

**B20. Testing without credentials or a binary: what can you prove, and what is left?**
`Testing.synth(stack, true)` + matchers prove structure, defaults, aspects, validation; snapshots prove "nothing changed unintentionally". Left: provider-side validation (`toBeValidTerraform` — needs the binary), plan-time errors (`toPlanSuccessfully` — needs credentials), and reality (deploy an ephemeral stack). Gate the last two behind env vars so `npm test` always runs.

**B21. Why do labels need a normaliser, and where does it live?**
GCP label keys/values: lowercase, `[a-z0-9_-]`, ≤ 63, key starts with a letter; AWS tags allow far more. One normaliser (`normaliseLabelKey/Value` in `shared/`) applied by the label aspect keeps `cost-center` / `Cost Center` / `costCenter` from becoming three labels. The aspect must skip data sources/providers and resources without `labels`.

**B22. `cdktf synth --hcl`: when is it the right default?**
When reviewers, policy tooling (Sentinel, some scanners) or ownership rules require HCL; when you want a committed, human-readable artefact as the exit ramp from CDKTF; when an HCL-only team consumes your output as a module. Cost: two artefacts to keep in sync (never hand-edit the HCL), and slightly different formatting than hand-written HCL. Terraform itself does not care.

---

## Part C — Cross-cutting design questions

**C1. Design the IaC platform for a 200-engineer organisation on AWS and GCP.**
Decide engines first: CloudFormation via AWS CDK on AWS, Terraform/OpenTofu on GCP (with CDKTF only for stamping-heavy programs, pinned, with the HCL exit ramp). One monorepo: `packages/environment` (business model: tiers, owners, cost centres — this repo's `shared/`), `packages/constructs-*` (versioned, platform-owned; `aws-cdk-lib`/`cdktf` as peer deps), `apps/<service>` (team-owned, pin construct versions), `platform/` (bootstrap templates, state buckets, WIF pools, applied by a break-glass pipeline), `policy/` (aspects + cdk-nag packs + Rego), reusable GHA workflows (plan-on-PR, deploy, drift, upgrade train). Governance engine-side: SCPs + permission boundaries + Hooks on AWS; org policies + folder IAM + Sentinel/OPA on GCP. Identity: OIDC roles per repo per env on AWS; WIF pools per repo per env on GCP; plan and apply identities separated. One environment model drives account/project maps, tags/labels, retention, approval gates. Release train: fortnightly framework/provider bumps reviewed by aggregated diffs across a canary app. On-call: deploy failures page the owning team; drift opens tickets; bootstrap/state changes page platform. What I would refuse: a single program that deploys both clouds, environment-agnostic prod stacks, `latest` on anything.

**C2. How do you roll out a breaking construct change across 300 stacks?**
Define "breaking": behaviour, or identity (logical ID/address). Ship the new behaviour behind an opt-in prop or context flag in a minor; publish a changelog that names ID impact; run the aggregated `cdk diff`/`cdktf diff` for every consumer in staging from the library's CI. Flip consumers in blast-radius order (dev → staging → prod; stateless → stateful), each as its own PR with the diff attached. For identity changes, generate the mapping once (`cdk refactor --dry-run` mapping file / `moved` blocks emitted by the construct itself for one version) and apply it in the same deploy as the flip. Remove the old path in the next major with a two-minor deprecation window. Never: a major that changes identity without a migration path; a flag flip in the same PR as a library bump.

**C3. What happens exactly when `cdk deploy` fails halfway?**
Assets were published (harmless, content-addressed). CloudFormation had executed a change set: resources created/updated in dependency order until one failed; the stack enters `UPDATE_ROLLBACK_IN_PROGRESS` (default) and reverses each completed change — deleting new resources, re-applying old properties — then `UPDATE_ROLLBACK_COMPLETE`; the CLI exits non-zero with the failing resource's event. If a reversal itself fails: `UPDATE_ROLLBACK_FAILED`, needing `cdk rollback --orphan`/`ContinueUpdateRollback`. With `--no-rollback`: the stack stays `UPDATE_FAILED` with the successful changes kept, and you fix-forward (no replacements allowed in that state). Custom resources run their `Delete`/rollback handlers during reversal — if they throw, you are in the failed-rollback branch. For a first `CreateStack` failure the stack goes `ROLLBACK_COMPLETE` and must be deleted before retrying. Nothing in `cdk.out` changes; the assembly is still deployable.

**C4. What happens exactly when `cdktf deploy` fails halfway?**
State lock acquired; `plan` computed; `apply` walks the graph with parallelism 10; each resource's result is written to state as it completes. On failure, Terraform stops scheduling new resources, waits for in-flight ones, writes state, releases the lock, exits non-zero. Everything applied stays applied; nothing is reverted. If a resource was created but the state write failed (or the API returned an error after creation), it is orphaned: next plan tries to create it again and gets 409 — fix with `importFrom`. Re-running is the recovery; the plan is idempotent. If the process was killed, the lock may be stale: `force-unlock` after confirming nothing runs.

**C5. Design the state and identity layout for 40 GCP projects across 3 environments.**
One state bucket per environment class (dev/staging/prod), in a dedicated "platform" project, CMEK, versioning + retention, uniform access, no public. Prefix per stack (`<layer>/<project>`), stacks layered (org/folders → project factory → network/Shared VPC → data → apps), dependencies via remote state only for non-secret values (subnets, project numbers), secrets via Secret Manager. Deploy SAs per environment per layer (a data-layer SA cannot read app state), WIF pool per environment with attribute conditions per repo. Break-glass SA with org-level roles, key creation disabled by org policy. Drift job per environment nightly; state backup job copying versions to a second region.

**C6. A team wants to move three resources from stack A to stack B on AWS. Plan it.**
If the resources are stateless: delete in A, create in B, accept the replacement — simplest. If stateful: option 1, `cdk refactor --unstable=refactor` with the two stacks (dry-run, inspect the mapping table, then apply; no other changes in the same operation; both stacks must exist; unstable — test in staging first). Option 2 (stable path): set `RETAIN`, deploy A; remove from A, deploy A (resources orphaned); add to B with matching properties, `cdk import B --resource-mapping`; deploy B; `cdk drift B`. Then remove the `RETAIN` scars if desired. Watch cross-stack references: consumers of the moved resources must switch from A's exports to B's, which is a strong-reference deadlock unless you `exportValue` on A for one deploy or use weak references.

**C7. Choose between weak references, SSM parameters and a shared construct library for wiring 30 microservice stacks to a platform stack.**
Weak references (2.254.0+): simplest code, automatic dependency, but producer changes break consumers silently until they redeploy; good for values that change rarely and where CDK owns both sides. SSM parameters (`valueForStringParameter`): fully decoupled lifecycles, cross-account/region-friendly, no dependency tracking, needs a contract doc and IAM on the parameters; good when platform and services deploy on different cadences or from different repos. A construct library exporting *how to look things up* (e.g. `PlatformVpc.fromContext(scope)`) on top of SSM gives both: decoupling plus a typed API. I would ship the library + SSM for anything crossing team boundaries and use references only inside one team's app.

**C8. The auditors want proof that every production resource is encrypted with a customer-managed key, on both clouds.**
Preventive, in-program: a READONLY aspect (`RequireCmek`) shared in spirit via `ConstructPolicy` and implemented per framework (module A06/B06) that fails synth for S3/EBS/RDS/DynamoDB and GCS/Cloud SQL/BigQuery/Pub/Sub without a CMK; cdk-nag NIST pack and a Rego rule on plan JSON as second opinions. Preventive, engine-side: SCP denying `s3:CreateBucket`/`rds:CreateDBInstance` without KMS conditions; GCP org policy `gcp.restrictNonCmekServices` and `gcp.restrictCmekCryptoKeyProjects`. Detective: AWS Config managed rules, Security Command Center findings, and a nightly `cdk drift`/`plan -refresh-only` job. Evidence: the synthesized templates/`cdk.tf.json` committed per release, `validation-report.json`, the plan JSON artefacts, and Config/SCC exports. The aspect alone is not evidence; the org policy plus Config/SCC is.
