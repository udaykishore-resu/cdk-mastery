# Migration Playbooks

> Exact commands, ordering, risk tables and rollback for the migrations you will actually be asked to do. Read chapter 10 of the [MASTERY-GUIDE](MASTERY-GUIDE.md) first for the primitives; the [DECISION-MATRIX](DECISION-MATRIX.md) for whether to migrate at all. Modules: [A10](../aws-cdk/src/modules/10-escape-hatches-custom-resources-and-migration/README.md) and [B10](../cdktf-gcp/src/modules/10-escape-hatches-hcl-migration-and-interop/README.md) have runnable versions of the key steps.

Versions: `aws-cdk-lib` 2.269.0, CLI 2.1141.0, `cdktf` 0.21.0, Terraform/OpenTofu ≥ 1.9.

Universal rules:

1. **Identity before behaviour.** Every playbook's first milestone is "the tool sees zero changes" (empty `cdk diff` / empty plan). Only then change anything.
2. **State is the asset.** Back it up before every step (CloudFormation: the deployed template + `describe-stack-resources`; Terraform: a state pull or bucket version).
3. **One stack/state at a time, stateless before stateful, dev before prod.**
4. **Every step has a rollback that does not require the tool you are migrating *to*.**

---

## Playbook 1 — CloudFormation → AWS CDK

Two routes, usually combined: **lift** (`CfnInclude`) then **replace progressively** (L2s with pinned logical IDs). `cdk migrate` is a third route for greenfield-ish codegen.

### 1a. Lift with `cloudformation-include`

```bash
# 0. Capture the source of truth
aws cloudformation get-template --stack-name legacy-orders --template-stage Original --query TemplateBody > legacy-orders.json
aws cloudformation describe-stacks --stack-name legacy-orders --query 'Stacks[0].Parameters' > legacy-orders.params.json
aws cloudformation detect-stack-drift --stack-name legacy-orders   # then describe-stack-drift-detection-status; fix drift FIRST

# 1. New CDK app, same stack name
npx cdk init app --language typescript
```

```ts
// lib/legacy-orders-stack.ts
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';
export class LegacyOrdersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, { ...props, stackName: 'legacy-orders' });     // the deployed stack name, exactly
    const tpl = new CfnInclude(this, 'Legacy', {
      templateFile: 'legacy-orders.json',
      preserveLogicalIds: true,                                        // default; never set false during migration
      parameters: { Env: 'prod' },                                     // replaces the Parameter with a literal
      loadNestedStacks: { ChildStack: { templateFile: 'child.json' } },
    });
    const table = tpl.getResource('OrdersTable') as dynamodb.CfnTable; // typed L1, same logical ID
  }
}
```

```bash
# 2. Prove identity
npx cdk synth --quiet
npx cdk diff legacy-orders --change-set          # expect: only Metadata/CDKMetadata/BootstrapVersion parameter additions
# If the diff shows anything else, fix the template you fed in (parameters, transforms) before continuing.

# 3. Take over
npx cdk bootstrap aws://ACCT/REGION               # once per env
npx cdk deploy legacy-orders --method change-set  # adds CDKMetadata + BootstrapVersion; no resource changes
```

`--version-reporting false` (or `versionReporting: false` in `cdk.json`) if even the metadata resource is unacceptable in the first deploy.

### 1b. Replace L1s with L2s, one resource at a time

```ts
// Remove OrdersTable from the included template file, then:
const table = new dynamodb.TableV2(this, 'Orders', { partitionKey: {...}, tableName: 'orders-prod', removalPolicy: RETAIN });
(table.node.defaultChild as dynamodb.CfnGlobalTable).overrideLogicalId('OrdersTable');   // identical logical ID
```

If the L2 renders a **different resource type** (e.g. `Table` → `TableV2` is `AWS::DynamoDB::Table` → `AWS::DynamoDB::GlobalTable`), same-ID replacement is impossible; use `cdk orphan --unstable=orphan` + `cdk import` (playbook 2) for that resource. Also watch for L2s that add sibling resources (bucket policies, log groups) — they are additive and safe, but they change the IAM surface; review the diff.

```bash
npx cdk diff legacy-orders --change-set   # must show *no replacement* ("[~]" with no "requires replacement")
npx cdk deploy legacy-orders
```

Repeat until `CfnInclude` is empty, then delete it. Keep `overrideLogicalId` calls — they are the price of history; document them.

### 1c. `cdk migrate` (codegen)

```bash
npx cdk migrate --stack-name legacy-orders --from-stack --language typescript --output-path ./legacy-orders
# or from a file:  --from-path legacy-orders.yaml
# or from a scan of the account (IaC generator):  --from-scan new --filter type=AWS::S3::Bucket
```

Produces an app with L1 constructs and the original logical IDs. Use it to bootstrap a repo, then apply 1b. `--from-scan` output is a *new* stack: the resources are not yet managed; you must `cdk import` them (playbook 2) — `cdk migrate` prints the import command.

### Risks and rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| Drift in the legacy stack makes the first CDK deploy revert manual changes | High | Drift detection before step 2; reconcile in the template first |
| Template used `Transform`/macros or `Fn::ForEach` that `CfnInclude` cannot parse | Medium | Expand macros (`--template-stage Processed`) or keep that section raw via `dehydratedResources` |
| A parameter you replaced with a literal was used for stack-set differentiation | Medium | Keep it as `CfnParameter` for the lift; replace when the L2 takes over |
| L2 swap changes resource type | Medium | orphan + import path; never same-ID |
| Nested stacks | Medium | `loadNestedStacks`; each becomes a `NestedStack` with its own template asset; `cdk import` does not work into nested stacks |
| Bootstrap absent / wrong qualifier | Low | `cdk bootstrap --show-template` reviewed and deployed by the platform team |

**Rollback at any step:** the stack is still a CloudFormation stack. `aws cloudformation update-stack --template-body file://legacy-orders.json --parameters file://legacy-orders.params.json` returns it to the pre-CDK template (the `CDKMetadata` resource and `BootstrapVersion` parameter simply disappear). Nothing in this playbook changes physical resources until you choose to.

---

## Playbook 2 — Console-created / ClickOps → AWS CDK (`cdk import`)

```bash
# 0. Inventory. Only import-supported types can be imported; check the list. Get every property that CloudFormation
#    considers create-only (name, encryption, engine version...) exactly as it is live.
aws s3api get-bucket-encryption --bucket orders-prod-archive; aws s3api get-bucket-versioning --bucket orders-prod-archive
aws rds describe-db-instances --db-instance-identifier orders-prod ...

# 1. Model the resources in a stack with NO other changes. Use RETAIN. Match physical names.
```

```ts
const archive = new s3.Bucket(this, 'Archive', { bucketName: 'orders-prod-archive', versioned: true,
  encryption: s3.BucketEncryption.KMS, encryptionKey: kms.Key.fromKeyArn(this, 'Key', 'arn:...'), removalPolicy: cdk.RemovalPolicy.RETAIN });
```

```bash
# 2. Make sure the stack has no pending changes, then import
npx cdk diff OrdersStack                          # nothing but the new resources
npx cdk import OrdersStack --record-resource-mapping mapping.json   # interactive first time; writes the mapping, no import
npx cdk import OrdersStack --resource-mapping mapping.json           # scriptable
# mapping.json: { "Archive2F1D6A3B": { "BucketName": "orders-prod-archive" } }

# 3. Verify
npx cdk drift OrdersStack --fail                  # CloudFormation compares your properties to reality
npx cdk diff OrdersStack                          # should be empty; if not, your model was wrong: fix code, deploy (no replacement!)
```

Alternative for resources with custom physical names: `cdk deploy --import-existing-resources` creates an import-type change set as part of a normal deploy. Bootstrap ≥ 12 required for `cdk import`. Resources that reference each other must be imported together or in dependency order. Nested stacks: not supported.

| Risk | Likelihood | Mitigation |
|---|---|---|
| Model differs from reality → next deploy modifies or replaces the resource | High | `cdk drift` right after import; `cdk diff --change-set` shows "requires replacement" — never deploy that |
| Import-unsupported type | Medium | Recreate (stateless) or leave outside CDK and reference via `fromXxxAttributes` |
| Someone else still "owns" the resource in the console | Medium | Tag `managed-by`, SCP/Config rule against console edits, communicate |

**Rollback:** set `DeletionPolicy: Retain` (already), remove the construct, deploy → the resource is orphaned again, unchanged. `cdk orphan --unstable=orphan` does the same in one command.

---

## Playbook 3 — Terraform HCL → CDKTF

The engine and state do not change; this is a *source* migration. The bar is an **empty plan** against the existing state.

```bash
# 0. Freeze and back up
cd legacy/network && terraform init && terraform plan -detailed-exitcode   # must be 0 (no drift, no pending changes)
terraform state pull > network.tfstate.backup.$(date +%s).json

# 1. Convert
mkdir -p cdktf/network && cd cdktf/network
npx cdktf init --template typescript --providers hashicorp/google@~>6.50 --project-name network   # or --from-terraform-project ../../legacy/network
cat ../../legacy/network/*.tf | npx cdktf convert --language typescript --stack > src/network-stack.ts
# With archived prebuilt bindings, prefer generating locally:  npx cdktf provider add hashicorp/google@~>6.50 --force-local
```

Clean the output: replace raw `TerraformResource`/string expressions with binding classes and `Fn.*`; keep resource **ids equal to the HCL names** so the addresses match (`resource "google_compute_network" "vpc"` → `new ComputeNetwork(this, 'vpc', ...)` renders `google_compute_network.vpc`); for resources created inside constructs, `overrideLogicalId('vpc')` or plan a `moved`. Modules: `TerraformHclModule(this, 'net', { source, version, variables })` renders `module.net` — same address as HCL if the id matches.

```ts
// Same backend, same prefix/workspace as the HCL root module
new GcsBackend(this, { bucket: 'platform-prod-tfstate', prefix: 'network' });
```

```bash
# 2. Prove identity — the crucial step
npx cdktf synth --hcl && diff <(terraform fmt - < cdktf.out/stacks/network/cdk.tf) <(cat ../../legacy/network/*.tf | terraform fmt -)  # eyeball
npx cdktf diff network            # goal: "No changes." Iterate on ids/moved blocks until it is.
# For an address that must change:  newRes.addMoveTarget('vpc'); or res.moveToId('google_compute_network.vpc')

# 3. Cut over
#   - CI: replace `terraform plan/apply` in legacy/network with `cdktf diff/deploy network` (or terraform against cdktf.out/stacks/network)
#   - Delete legacy/network/*.tf in the same PR; keep the backend block history in git
npx cdktf deploy network          # applies the (empty or moved-only) plan; removes nothing
```

Coexistence while migrating many root modules: leave HCL modules untouched; a CDKTF stack reads their outputs with `new DataTerraformRemoteStateGcs(this, 'legacy-net', { bucket, prefix: 'network' }).getString('vpc_id')`, and HCL reads CDKTF outputs with `terraform_remote_state` the same way. Migrate leaves first (no dependants), roots last.

| Risk | Likelihood | Mitigation |
|---|---|---|
| Address mismatch → destroy/create of everything | High (first attempt) | Empty-plan gate; `moved` blocks; never `--auto-approve` before the gate passes |
| `cdktf convert` mistranslates expressions (`for`, `dynamic`, conditionals) | High | Compare `--hcl` output; rewrite with iterators/`Fn`; unit tests on synthesized JSON |
| Provider version drift (HCL pinned 5.x, bindings 6.50) | Medium | Match the provider version first in HCL (upgrade there, apply), then convert |
| Lock file / plugin cache differences | Low | Commit `.terraform.lock.hcl` copied from `cdktf.out`; `terraform providers lock` |
| Sensitive values now in generated outputs (cross-stack) | Medium | Prefer data sources by name for secrets; state bucket CMEK |

**Rollback:** the state was never touched by a non-empty plan until step 3; `git revert` the CI change and run the HCL again. After a `moved` apply, rollback means the reverse `moved` (or `terraform state mv` back).

---

## Playbook 4 — AWS CDK ↔ CDKTF (either direction)

This is **not a migration; it is a re-platform.** Different engine (CloudFormation vs Terraform), different state model (managed vs file), different identity (logical ID vs address), different resource model (CFN registry types vs provider schemas — property names, defaults, and even what counts as one resource differ). No tool converts between them. What you are doing is: build the same infrastructure in the other tool, then move the *physical resources* from one owner to the other without downtime.

### What can be shared

- Anything written purely against `constructs`: this repo's `shared/` (environment model, naming, label/tag normalisers, `ConstructPolicy` walker and rules). Both capstones import it unchanged.
- Orchestrating constructs that delegate leaf resources via an interface (`interface IObjectStore { grantRead(...) }` with an AWS and a GCP implementation) — rare in practice; do not design for it unless you are actually on both clouds.
- Tests of the shared code; CI workflow shapes; the environment/ownership model; naming.
- Nothing about tokens, references, assets, aspects with priorities, custom resources, backends or bootstrap.

### CDK → CDKTF (AWS resources managed by Terraform afterwards)

```bash
# 0. Inventory the CloudFormation stack's physical IDs
aws cloudformation describe-stack-resources --stack-name orders-prod --query 'StackResources[].[LogicalResourceId,ResourceType,PhysicalResourceId]' --output table

# 1. Write the CDKTF stack (aws provider bindings via `cdktf provider add hashicorp/aws --force-local`) modelling the SAME resources.
# 2. Adopt: importFrom() per resource (generateConfigForImport helps discover attributes), plan until the only changes are "import"
npx cdktf diff orders-prod               # expect: N to import, 0 to add/change/destroy
# 3. Detach from CloudFormation WITHOUT deleting: set DeletionPolicy Retain on everything, deploy; then delete the stack
#    (retained resources survive).  In CDK: an aspect that applyRemovalPolicy(RETAIN) on every CfnResource, cdk deploy, then
npx cdk destroy orders-prod              # deletes the stack record; retained resources stay
# 4. Apply the imports
npx cdktf deploy orders-prod
```

Order matters: adopt into Terraform state (step 2/4 can be done *before* step 3 — Terraform does not care that CloudFormation also "owns" the object — but two owners is the dangerous window; keep it short and freeze deploys).

### CDKTF → CDK (resources managed by CloudFormation afterwards)

```bash
# 1. Write the CDK stack modelling the same resources with RETAIN and exact physical names.
# 2. Remove from Terraform state without destroying:
cd cdktf.out/stacks/orders-prod && terraform state rm aws_dynamodb_table.orders     # or a `removed` block via stack.addOverride
# 3. Import into CloudFormation
npx cdk import OrdersStack --resource-mapping mapping.json
npx cdk drift OrdersStack --fail
```

Only import-supported CloudFormation types can be adopted; everything else must be recreated (blue/green) — which is why this direction is harder than the other.

| Risk | Likelihood | Mitigation |
|---|---|---|
| Resource types that exist in one model but not the other (CloudFormation custom resources; Terraform provisioners) | Certain | Re-implement: custom resource ↔ external job/provider |
| Two owners during cutover | Certain | Deploy freeze; do it per stack; monitoring on the resources |
| Physical name mismatch | High | Freeze names in both codebases before migration; never let either tool generate names for stateful things |
| Data-plane objects (S3 objects, DynamoDB items) | Low | Not touched by either tool; verify retention policies |

**Rollback:** before the "delete stack" / "state rm" step, simply stop; the original owner still has everything. After it, reverse the adoption (import back with `cdk import` / `importFrom`).

---

## Playbook 5 — Pulumi ↔ either (brief)

Pulumi → Terraform/CDKTF: `pulumi stack export > state.json` gives every resource's provider ID; build the CDKTF/HCL model and `import` each (Pulumi's bridged providers use the same IDs as the Terraform provider for AWS/GCP, which makes discovery mechanical); then `pulumi state delete` or `pulumi destroy --exclude-protected` after `protect`ing everything (never a plain `destroy`). Pulumi → CDK: the same via `cdk import`; only import-supported types.

Terraform/CDKTF → Pulumi: `pulumi convert --from terraform --language typescript` converts HCL (synth `--hcl` first from CDKTF); `pulumi import` per resource, or the bulk `pulumi import --from terraform ./terraform.tfstate` state adopter. CDK → Pulumi: there is no converter; the `@pulumi/cdk` adapter runs CDK constructs *inside* a Pulumi program (a bridge that keeps the CDK code and swaps the engine — its coverage of CloudFormation-only features such as custom resources is partial; *unverified for current versions*), otherwise model and `pulumi import`.

Risk profile is the same as playbook 4: it is a re-platform; the state export is the asset; two owners is the dangerous window.

---

## Quick reference: primitives by direction

| From → To | Adopt into new owner | Release from old owner | Identity tool |
|---|---|---|---|
| CFN → CDK | `CfnInclude` (no adoption needed; same stack) | — | `preserveLogicalIds`, `overrideLogicalId` |
| Console → CDK | `cdk import`, `cdk deploy --import-existing-resources`, `cdk migrate --from-scan` | — | physical names |
| HCL → CDKTF | (same state) | — | ids = HCL names, `moved`, `overrideLogicalId` |
| CDK → CDKTF | `importFrom`, `terraform import` | `RETAIN` + `cdk destroy`, or `cdk orphan` | physical IDs |
| CDKTF → CDK | `cdk import` | `terraform state rm` / `removed` block | physical names |
| Pulumi → TF | `import` block / `pulumi import --from terraform` (reverse) | `pulumi state delete` | provider IDs |
| Stack → stack (CDK) | `cdk refactor --unstable=refactor` or orphan + import | — | resource digests / mapping file |
| Stack → stack (CDKTF) | `terraform state mv -state-out` + `importFrom` | `state rm` | addresses |
