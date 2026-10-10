# Decision Matrix: which IaC tool, for whom, in 2026

> Facts are dated. Vendor situations move; re-check anything older than a quarter before quoting it in a design review. The mechanics behind each row are in the [MASTERY-GUIDE](MASTERY-GUIDE.md); the concept mapping in the [ROSETTA-STONE](ROSETTA-STONE.md).

## The candidates

| Tool | What it is | Engine | Licence / steward (as of 2026-09) |
|---|---|---|---|
| **AWS CDK** | TypeScript/Python/Java/.NET/Go program → CloudFormation | CloudFormation | Apache-2.0; AWS. `aws-cdk-lib` 2.269.0 (2026-09-10), CLI 2.1141.0. Weekly releases. |
| **CDK for Terraform (CDKTF)** | Same languages → Terraform JSON/HCL | Terraform or OpenTofu | MPL-2.0; HashiCorp (IBM). `cdktf` 0.21.0 (2025-06-04), **no release since**. Prebuilt provider packages archived 2025-12-10 (verbatim in the installed `@cdktf/provider-google` README); bindings must now be generated locally with `cdktf get`/`provider add --force-local`. |
| **Terraform (HCL)** | Declarative HCL | Terraform | BUSL-1.1 since 2023-08-10 (v1.6+); HashiCorp, acquired by IBM (closed 2025-02-27). Free to use in production; forbidden to embed in a product that competes with HashiCorp's. |
| **OpenTofu** | Fork of Terraform 1.5.x, HCL-compatible | OpenTofu | MPL-2.0; Linux Foundation. GA 1.6 in 2024-01; state encryption (1.7), provider `for_each` (1.9), OCI registries (1.10) are fork-only features. Drop-in for CDKTF via `TERRAFORM_BINARY_NAME=tofu`. |
| **Pulumi** | TS/Python/Go/.NET/Java/YAML program with its own engine | Pulumi engine | Apache-2.0 engine; Pulumi Cloud is a commercial SaaS (self-managed backends on S3/GCS/Azure are free). Can bridge any Terraform provider. |
| **CloudFormation (direct)** | YAML/JSON templates | CloudFormation | AWS-managed service; free (except for third-party registry resource handler invocations). |
| **Crossplane / Config Connector / ACK** | Kubernetes CRDs reconciled by controllers | Kubernetes controllers | Crossplane: Apache-2.0, CNCF. Config Connector (GCP): Google-maintained, GKE add-on or standalone. ACK (AWS Controllers for Kubernetes): Apache-2.0, AWS. |

Google's stance: there is **no first-party GCP CDK**. Google's own IaC products are **Infrastructure Manager** (a managed service that *runs Terraform* against GCS-hosted state, GA 2023) and **Config Connector** (KRM). Google publishes and maintains the `hashicorp/google` provider jointly with HashiCorp (the "Magic Modules" generator) and the `terraform-google-modules` blueprints. Practically: on GCP, Terraform *is* the first-party IaC, and CDKTF is a thin programmatic skin over it.

AWS's stance: CDK is the recommended authoring tool for CloudFormation; the CloudFormation registry and Cloud Control API are the strategic control plane; AWS funds CDK, cdk-nag, Construct Hub, projen, `integ-tests`, and the CDK team ships weekly. AWS also maintains the Terraform `aws` provider jointly with HashiCorp and publishes ACK; it does not favour one over the other in messaging, but its investment is visibly CDK-first.

## Criteria

Scores are qualitative (● strong, ◐ mixed, ○ weak) and reflect the author's judgement in September 2026, not a benchmark.

| Criterion | AWS CDK | CDKTF | Terraform/OpenTofu HCL | Pulumi | Crossplane / KCC / ACK | CloudFormation direct |
|---|---|---|---|---|---|---|
| **Cloud mix: AWS only** | ● | ◐ (works; no L2, why bother) | ● | ● | ◐ (ACK coverage partial) | ◐ |
| **Cloud mix: GCP only** | — | ◐ (Terraform's provider, programmatic skin; vendor risk) | ● | ● | ● KCC is mature for GCP | — |
| **Cloud mix: both + SaaS (GitHub, Datadog, Cloudflare)** | ○ (AWS only) | ◐ (any provider) | ● | ● | ◐ (Crossplane providers: Upbound's are the mature ones) | ○ |
| **Team language skills: TS/Python/Go/Java engineers** | ● | ● | ◐ (HCL is easy to read, hard to abstract) | ● | ◐ (YAML + controllers) | ○ |
| **Team skills: ops/SRE with Terraform background** | ○ | ◐ | ● | ◐ | ◐ | ○ |
| **Existing state / modules** | ◐ (`cdk migrate`, `CfnInclude`, `cdk import`) | ● (coexists with HCL state; `cdktf convert`; same providers) | ● | ◐ (`pulumi convert --from terraform`; bridged providers keep resource semantics but state must be imported) | ○ (import per object) | ● |
| **Need for L2 abstractions (secure defaults, `grant*`)** | ● | ○ (write your own; registry modules are opaque) | ◐ (modules) | ◐ (Pulumi Crosswalk for AWS; less for GCP) | ◐ (Compositions) | ○ |
| **Policy tooling** | ● cdk-nag, Validations, Guard, Hooks | ◐ conftest/OPA on JSON plan; Sentinel on HCP | ● Sentinel/OPA/checkov/tfsec, mature | ◐ CrossGuard | ● Gatekeeper/Kyverno on CRDs | ◐ Guard/Hooks |
| **Org governance (accounts/projects, boundaries)** | ● bootstrap trust, permission boundaries, SCPs integrate with the CLI model | ◐ your own state layout + WIF; org policies are just resources | ◐ same as CDKTF, with HCP Terraform/TFE workspaces as the governance unit | ◐ Pulumi Cloud RBAC or DIY | ◐ namespaces/RBAC; multi-tenancy is hard | ● StackSets, Service Catalog |
| **Hiring** | ● large TS/CDK pool for AWS shops | ○ small; candidates are "Terraform people who can code" | ● largest IaC pool | ◐ growing | ◐ platform-eng niche | ◐ shrinking |
| **Vendor posture / longevity risk** | ● first-party, funded, weekly | ○ **highest risk**: core last released 2025-06; prebuilt bindings archived 2025-12; IBM's roadmap for CDKTF unstated | ◐ BUSL; IBM; OpenTofu is the hedge | ◐ VC-funded vendor; open engine | ● CNCF / Google / AWS | ● |
| **Testing ergonomics** | ● `assertions`, `integ-tests` | ◐ jest matchers; validity/plan tests need the binary | ◐ `terraform test`, terratest | ● mocks + Automation API | ○ e2e only, needs a cluster | ○ |
| **Preview fidelity** | ◐ change sets (no refresh, some replacement blind spots) | ● plan with refresh | ● | ● | ○ (reconcile loop; no plan) | ◐ |
| **Failure handling** | ● automatic rollback | ◐ partial apply, idempotent retry | ◐ | ◐ | ◐ continuous reconcile (self-heals, also fights you) | ● |
| **Day-2: rename/move/import** | ◐ `refactor`/`orphan` are unstable; `import` fine | ● `moved`/`import`/`removed` in code | ● | ● aliases/import | ◐ | ○ |
| **Kubernetes-native platform (Backstage, GitOps, tenants self-serve)** | ○ | ○ | ○ | ○ | ● the whole point | ○ |
| **Cost of the tool itself** | free | free | free (HCP Terraform paid tiers) | engine free; Cloud paid per resource | free; cluster to run it | free |

## Archetypes

### 1. AWS-only product company (50–500 engineers, several product teams, one platform team)

**Recommendation: AWS CDK**, TypeScript, one monorepo, a construct library owned by the platform team, `pipelines.CodePipeline` or GHA+OIDC per app, cdk-nag with a curated pack, bootstrap with a custom permissions boundary and a qualifier per platform generation. Reasons: L2s give product teams secure defaults without a platform ticket; `grant*` makes least-privilege the easy path; cdk-nag/Validations give the security team a hook that runs on every laptop; the vendor risk is the lowest in the table; hiring is easy.

Do not: adopt CDKTF "to keep options open" — the option you keep is one you would exercise by re-platforming anyway (see [MIGRATION](MIGRATION.md)). Do not use plain CloudFormation for new work except for StackSets/Service Catalog products where CFN is the delivery format (author them in CDK and ship the synthesized template).

Watch-outs: CloudFormation coverage of brand-new services lags by weeks (L1s follow the registry; use `CfnResource` with the new type or an `AwsCustomResource`); template size and 500-resource limits push you to split stacks early; `crossRegionReferences` for the CloudFront/ACM `us-east-1` dance.

### 2. Multi-cloud enterprise with an existing Terraform platform team (thousands of engineers, AWS + GCP + Azure, TFE/HCP Terraform, Sentinel, a module registry)

**Recommendation: keep Terraform (HCL) as the platform substrate; decide OpenTofu vs Terraform on licence/feature grounds, not on IaC style; do *not* introduce CDKTF at the platform layer; allow AWS CDK for AWS-native application teams that want it, with the platform team owning the bootstrap and the boundaries.** Reasons: the platform team's assets (modules, Sentinel policies, workspace conventions, run tasks, drift dashboards) are HCL-shaped and cloud-agnostic; CDKTF would add a jsii toolchain, a second review artefact (`cdk.tf.json`), and a dependency on a project with no releases since 2025-06 and archived bindings. Application teams on AWS gain more from CDK's L2s than they lose from having two tools, provided the *governance* is engine-side (SCPs, Hooks, Sentinel/run tasks, OPA), not tool-side.

If the enterprise insists on "everything in TypeScript": Pulumi is the more defensible choice than CDKTF today (funded, releases monthly, bridges every Terraform provider, converts HCL), at the cost of a new engine and state format; run the numbers on Pulumi Cloud versus self-managed backends before committing.

Watch-outs: BUSL matters only if you *embed* Terraform in a product you sell; OpenTofu's state encryption and provider `for_each` are real advantages for regulated multi-tenant setups; keep one engine per state file (never apply the same state with both).

### 3. GCP-first startup (10–40 engineers, TypeScript everywhere, Cloud Run + Cloud SQL + Pub/Sub + BigQuery, GitHub)

**Recommendation: Terraform HCL with `terraform-google-modules` blueprints, GCS backend, GHA + Workload Identity Federation — *or* CDKTF if the team is allergic to HCL and accepts the maintenance risk with eyes open.** Reasons: on GCP the provider is the product; CDKTF adds type-checked composition (genuinely useful for the project-factory / per-service stamping pattern in module B09) but no defaults, no grants, no rollback, and a toolchain (Node, jsii, generated bindings ~ tens of MB) that a 20-person team must own. A startup that chooses CDKTF must: generate bindings locally (`cdktf provider add hashicorp/google --force-local`), pin `cdktf` 0.21.0, keep `--hcl` synthesis working as the exit ramp (commit the HCL if CDKTF dies; the state is unchanged), and use OpenTofu or Terraform ≥ 1.9.

Pulumi is the second-best fit here (native GCP SDK, TypeScript, good testing story) if the team wants a program rather than a config and would rather pay for Pulumi Cloud than run a state bucket.

Do not: Config Connector unless the company already runs GKE as a platform; Infrastructure Manager unless you want Google to run your Terraform for you (fine for small estates; opaque for debugging).

### 4. Regulated bank with CloudFormation history (change-advisory boards, evidence packs, Service Catalog, StackSets across 300 accounts, auditors who read templates)

**Recommendation: AWS CDK as the authoring layer, CloudFormation as the *evidence* layer.** Synthesize in CI, commit or archive the templates as the reviewed artefact (auditors keep reading YAML), deploy the assembly through StackSets/Service Catalog where the control framework already lives, add cdk-nag (NIST 800-53 r5 / PCI packs) plus CloudFormation Hooks/Guard for engine-side enforcement, bootstrap with a customer-owned template (`--template`) whose roles are reviewed like any privileged role, and use `cdk migrate`/`CfnInclude` to bring the estate under CDK incrementally without touching logical IDs ([MIGRATION](MIGRATION.md) playbook 1). Reasons: no new engine, no new state store to certify, the existing controls keep working, and the CDK program adds testability and abstraction on top. Terraform/OpenTofu would mean certifying a new state store, a new set of runners and a new policy engine; the bank's *other* clouds (if any) are the only reason to do that.

Watch-outs: `--method direct` and `--hotswap` must be forbidden by policy (they bypass change sets/CloudFormation); change sets are the CAB artefact; `cdk deploy --method prepare-change-set` + `execute-change-set` maps onto a two-step approval; keep `cdk.context.json` lookups out of prod pipelines (`--lookups=false`).

## Sharper questions than "which tool"

1. **Where will policy be enforced?** If the answer is "in the tool", you have chosen the tool that your least disciplined team can bypass. Engine-side (Hooks/SCPs; org policies/Sentinel) first; tool-side for feedback.
2. **Who owns identity changes?** Every tool in the table makes some rename a replacement. The one with the best story *for your engine* wins the day-2 argument: `moved` blocks (Terraform/CDKTF) are mature; `cdk refactor` is unstable in CLI 2.1141.
3. **What is the exit ramp?** CDK → templates exist in `cdk.out` forever; CDKTF → `--hcl` output plus unchanged state; Pulumi → `pulumi convert` out is weak (state export is the real asset); Crossplane → export the objects, re-import elsewhere.
4. **How many engines can you afford to be on-call for?** One per cloud is defensible; two per cloud is not.

## What I would do (opinion)

Labelled as such, and it is what the repo's two capstones encode.

- **AWS-heavy or AWS-only: AWS CDK, no hesitation.** The L2 layer, `grant*`, cdk-nag/Validations, and the bootstrap trust model are a decade of accumulated correctness you do not get to rebuild. I would pay the CloudFormation tax (slow, opaque state, coverage lag) for it.
- **GCP: Terraform/OpenTofu HCL for the platform layers (org, folders, projects, Shared VPC, WIF), and a *program* only where stamping is real — a project factory, per-service stacks, or many near-identical environments.** For that program I would use CDKTF today only with the mitigations above (locally generated bindings, HCL exit ramp, pinned 0.21.0), and I would re-evaluate against Pulumi every six months. If HashiCorp/IBM ships a `cdktf` 0.22 with a stated roadmap, the calculus improves; if another year passes without one, I would freeze new CDKTF work and treat existing stacks as HCL-with-a-generator.
- **Never one program that deploys both clouds.** Share the environment model, naming, and policy walkers (this repo's `shared/`); keep the engines, states and pipelines separate.
- **Never plain CloudFormation or plain YAML for new authoring** when a CDK exists for the engine; the templates are still there as the reviewed artefact.
- **Crossplane/KCC only when the platform *is* Kubernetes** and tenants consume infrastructure through claims; it is a different product (a control plane) rather than a different IaC tool, and the comparison in the table above undersells it for that use and oversells it for everything else.
