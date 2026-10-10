# 05 · Constructs & modules

> After this module you can design a reusable CDKTF construct the way AWS CDK designs an L2 (props interface, `I*` contract, `grant*` API, synth-time validation, isolated tests), consume Terraform Registry modules with and without generated bindings, and know what it takes to publish a construct library for Python and Go consumers.

## Why this exists (the problem)

Modules 00–04 wrote resources directly. That is fine for one team and one project; it does not survive the second team. The `SecureBucket` settings, the Pub/Sub dead-letter grants, the "no primitive roles" rule — each was a code review comment in module 03 or 04 and will be a code review comment again next month unless it becomes code. Terraform's answer is the module: a directory with `variables.tf`, `main.tf`, `outputs.tf`, an untyped contract, no methods, no interfaces, and a version on the Registry. CDKTF's answer is the construct: a class with a typed props interface, methods that create resources on demand (`grantRead`), interfaces that let consumers depend on a contract rather than an implementation, and validation that runs before Terraform ever sees the JSON. Both exist in the same program; this module shows when to reach for which.

## Mental model

A construct is a **function from props to a subtree**, with methods that can grow the subtree later. Compare the three ways to reuse:

| | Terraform module (HCL) | `TerraformHclModule` (from TS) | Construct (TS class) |
|---|---|---|---|
| Contract | `variable`/`output` blocks, untyped from TS | same, `variables: {…}` map | TypeScript interface, compiler-checked |
| Behaviour after creation | none | none | methods (`grant*`, `addLifecycleRule`) |
| Validation | `validation` blocks at plan time | plan time | synth time (`node.addValidation`, `Annotations`) + plan time |
| Testing | `terraform test` (needs binary) | assert the `module` block in JSON | `Testing.synthScope`, no binary |
| Versioning | Registry semver | Registry semver | npm semver (jsii for other languages) |
| Reuse from HCL projects | yes | n/a | no (unless you `cdktf synth --hcl` and vendor the output) |
| Best for | org-standard pieces shared with HCL teams; things Google already maintains (network, project factory) | consuming those from CDKTF | your platform's opinions and APIs |

Decision rule: **consume** a Registry module when one exists, is maintained by Google/HashiCorp, and matches your opinions (`terraform-google-modules/*`); **write a construct** when the reuse is about *your* rules or needs a runtime API (`grant*`); **wrap** a module in a thin construct when both are true (exercise 3).

## How it works

### `SecureBucket` ([`secure-bucket.ts`](secure-bucket.ts))

```ts
export interface ISecureBucket extends IConstruct {
  readonly bucketName: string;
  readonly bucketUrl: string;
  grantRead(id: string, member: string): StorageBucketIamMember;
  grantWrite(id: string, member: string): StorageBucketIamMember;
}

export class SecureBucket extends Construct implements ISecureBucket {
  constructor(scope: Construct, id: string, props: SecureBucketProps) {
    super(scope, id);
    this.node.addValidation({ validate: () => { /* name regex unless token, retention > 0, project when CMEK */ } });
    if (tier.retainStatefulResources && props.forceDestroy) Annotations.of(this).addError(`forceDestroy is not allowed in ${tier.name}`);
    if (tier.retainStatefulResources && !props.accessLogsBucket) Annotations.of(this).addWarning('prod buckets should ship access logs (accessLogsBucket)');
    // CMEK: grant the GCS service agent use of the key, and make the bucket wait for the grant
    this.bucket = new StorageBucket(this, 'Bucket', { uniformBucketLevelAccess: true, publicAccessPrevention: 'enforced', versioning: { enabled: true }, encryption, dependsOn, logging, lifecycleRule: [...] });
  }
  grantRead(id, member) { return new StorageBucketIamMember(this, id, { bucket: this.bucket.name, role: 'roles/storage.objectViewer', member }); }
}
```

Conventions, all borrowed from AWS CDK's L2 design because they are the ones a decade of construct authors converged on:

- **Props interface, `readonly` fields, defaults in the constructor.** The tier drives defaults (`forceDestroy`, retention) so consumers write intent, not policy.
- **`I*` interface for the contract.** `ConstructsStack` passes `this.logs` (a `SecureBucket`) as `accessLogsBucket: ISecureBucket`; exercise 1's `importSecureBucket()` returns an `ISecureBucket` backed by a data source, and everything downstream works unchanged. This is the `from*` pattern: `Bucket.fromBucketName()` in AWS CDK.
- **`grant*` methods create additive IAM members in the construct's own scope.** They are removed with the construct, they never touch other principals (`_iam_member`, module 04), and callers pass an explicit id so a refactor does not renumber resources. `PubSubPipeline.grantPublish(member, id?)` auto-generates ids when you do not care.
- **Two validation channels.** `node.addValidation()` returns a list of hard errors; `Testing.synth(stack, true)`, `Testing.fullSynth`, and `cdktf synth` collect them across the whole tree and report all of them at once (the test asserts two errors in one message). `Annotations.of(this).addWarning/addError` write to the construct's metadata: warnings appear in `manifest.json` under `annotations` and are printed by the CLI; an error aborts synth with the construct path. Use validations for "this cannot work" and annotations for "this violates policy", because policy is what module 06's aspects add and remove.
- **Token-aware validation.** `Token.isUnresolved(props.name)` skips the regex when the name is a token; validating a token is a bug, not a feature.

### `PubSubPipeline` and `ServiceAccountWithRoles`

[`pubsub-pipeline.ts`](pubsub-pipeline.ts) generalises module 04's topic + DLQ + subscription + service-agent grants and exposes `grantPublish(member)`/`grantSubscribe(member)`. It validates `maxDeliveryAttempts ∈ [5, 100]` and `ackDeadlineSeconds ∈ [10, 600]` at synth — the API would reject them at apply, thirty seconds later and with less context.

[`service-account-with-roles.ts`](service-account-with-roles.ts) creates an SA and one `ProjectIamMember` per role with an id derived from the role (`RolepubsubsubscriberX`), so adding or removing a role touches exactly one resource. Primitive roles (`roles/owner|editor|viewer`) are an **error annotation**: the synth fails with the construct path. `grantImpersonation()` and `grantActAs()` expose the two SA-level grants every platform needs.

### Logical ids inside constructs

A top-level element keeps its construct id (`google_storage_bucket.Artifacts`). Anything nested gets `makeUniqueId(pathComponents)` = human-readable components joined with `_`, capped at 240 chars, plus an 8-hex-char hash of the full path: `Data_Bucket_1A2B3C4D`. Two details bite: `Default` components are removed, `Resource` is hidden from the human part but hashed; and **consecutive duplicate components are collapsed** (`Vpc/Vpc/Vpc` → `Vpc_<hash>`, the test shows it). The hash makes ids stable across machines and synths, and means renaming *any* ancestor construct changes every nested address — which is what `moveTo` (module 02) and `overrideLogicalId` (module 01) exist for.

### Registry modules: `TerraformHclModule` ([`registry-network.ts`](registry-network.ts))

```ts
this.module = new TerraformHclModule(this, 'Vpc', {
  source: 'terraform-google-modules/network/google',
  version: '~> 11.0',
  variables: { project_id, network_name, routing_mode, subnets, secondary_ranges },
});
this.networkName = this.module.getString('network_name');
this.subnetIds = this.module.getList('subnets_ids');
```

Renders `module.<id> = { source, version, …variables }`; outputs are `${module.<id>.network_name}`. `terraform init` downloads the module into `.terraform/modules/`; **synth is offline** and the test asserts the `module` block without any network access. `variables` is untyped — a typo is a plan-time "Unsupported argument" — so `RegistryNetwork` wraps it in a typed props interface and typed output properties: the type safety is restored at the boundary where it matters, and the module's own semver still applies. `TerraformHclModule` also takes `providers` (for modules that need aliased providers), `dependsOn` (other modules), and `forEach` (an iterator, for module-per-region patterns).

### Registry modules: generated bindings (`cdktf get`)

The alternative gives you a typed class per module. Steps, exactly:

1. In `cdktf.json`: `"terraformModules": [{ "name": "google-network", "source": "terraform-google-modules/network/google", "version": "~> 11.0" }]` (a bare string `"terraform-google-modules/network/google@~> 11.0"` also works).
2. `npx cdktf get` — downloads the module, reads `variables.tf`/`outputs.tf`, writes `.gen/modules/google-network/index.ts` (TypeScript only; not jsii).
3. `import { GoogleNetwork } from '../.gen/modules/google-network';` then `new GoogleNetwork(this, 'Vpc', { projectId, networkName, subnets: [...] })` — camelCased typed inputs, `networkNameOutput` typed outputs.
4. Commit nothing under `.gen/` (gitignored here); run `cdktf get` in CI before `synth`.

Costs: `cdktf get` needs network access and Terraform's module fetcher (it shells out to `terraform`), object-typed variables become `any` because HCL `object({...})` types do not round-trip, and the generated class is tied to the module version in `cdktf.json`. This repo pins `terraformModules: []` so `cdktf get` is never required; module 10 uses it for a community provider.

### Packaging for other languages: projen + jsii

A construct library consumed from Python or Go must be compiled with **jsii**, which enforces a language-neutral subset of TypeScript (no `Partial<>`, no unions of classes, interfaces named `I*` for behavioural interfaces, `readonly` props, no overloads). projen scaffolds the whole thing:

```
npx projen new cdktf-construct --name @acme/cdktf-gcp-constructs
```

which writes a `.projenrc.ts` like this (described, not run in this repo — projen is not installed here):

```ts
import { cdktf } from 'projen';

const project = new cdktf.ConstructLibraryCdktf({
  name: '@acme/cdktf-gcp-constructs',
  author: 'Platform Team',
  authorAddress: 'platform@acme.example',
  repositoryUrl: 'https://github.com/acme/cdktf-gcp-constructs',
  defaultReleaseBranch: 'main',
  cdktfVersion: '0.21.0',
  constructsVersion: '10.8.1',
  peerDeps: ['@cdktf/provider-google@^16.12.0'],
  bundledDeps: ['@cdk-mastery/shared'],
  publishToPypi: { distName: 'acme-cdktf-gcp-constructs', module: 'acme_cdktf_gcp_constructs' },
  publishToGo: { moduleName: 'github.com/acme/cdktf-gcp-constructs-go' },
  jsiiVersion: '~5.9',
});
project.synth();
```

`projen` then owns `package.json`, `tsconfig.json`, the jsii compile (`npx projen build`), API docs (`API.md` via jsii-docgen), a release workflow with per-language publishing, and an upgrade workflow. Rules of thumb for a jsii library: providers are **peer** dependencies (the consumer picks the version; a bundled provider would double the install and break token identity), the shared library is **bundled** (pure TypeScript, no jsii metadata), and every public prop interface is exported.

### Do not mix `aws-cdk-lib` and `cdktf` constructs in one `App`

Both frameworks build a `constructs` tree, so TypeScript will let you put an `aws-cdk-lib` `Bucket` under a `TerraformStack`. It will not work: the two have **different synthesizers** (`App.synth()` in cdktf walks `TerraformStack`s and calls `toTerraform()`; `cdk.App.synth()` walks `Stage`s and produces a Cloud Assembly), **different aspect systems** (`Aspects` from `cdktf` vs `Aspects` from `aws-cdk-lib`, each only visiting its own tree), and **different token implementations** (`${TfToken[TOKEN.n]}` vs `${Token[TOKEN.n]}`, resolved by different resolvers). An `aws-cdk-lib` token inside a CDKTF resource serialises as a literal marker string; a CDKTF token inside a CloudFormation template does the same. `@cdk-mastery/shared` is the only thing both tracks share, and it imports only `constructs` — that boundary is the point of the whole repo.

## Walkthrough

1. [`secure-bucket.ts`](secure-bucket.ts) — `ISecureBucket`, `SecureBucket`, validation and annotations, CMEK, `grant*`.
2. [`pubsub-pipeline.ts`](pubsub-pipeline.ts) — `PubSubPipeline` with `grantPublish`/`grantSubscribe`.
3. [`service-account-with-roles.ts`](service-account-with-roles.ts) — role-derived ids, primitive-role error, `grantImpersonation`/`grantActAs`.
4. [`registry-network.ts`](registry-network.ts) — `TerraformHclModule` wrapped in a typed construct.
5. [`constructs-stack.ts`](constructs-stack.ts) — the consumer's view; `cmek: true` adds a KMS key. [`index.ts`](index.ts) registers `m05-constructs` (`CDKM_CMEK=1` for the key).
6. [`../../../test/05-constructs-and-modules.test.ts`](../../../test/05-constructs-and-modules.test.ts) — `Testing.synthScope` for each construct, validation and annotation behaviour, the `module` block.

```
npx jest test/05-constructs-and-modules.test.ts
bash ../scripts/typecheck-module.sh cdktf-gcp 05-constructs-and-modules
CDKM_CMEK=1 npx cdktf synth
```

### Testing constructs in isolation

```ts
const synth = Testing.synthScope((scope) => {
  const b = new SecureBucket(scope, 'Data', { tier: ENVIRONMENTS.dev, name: 'cdkm-lib-dev-data', location: 'US', service: 'lib' });
  b.grantRead('Reader', 'group:analysts@example.com');
});
expect(synth).toHaveResourceWithProperties(StorageBucket, { public_access_prevention: 'enforced', … });
```

`synthScope` creates a throwaway `TerraformStack` named `stack`, runs your callback, and returns the JSON — no provider, no app boilerplate. It does **not** run validations or check for providers; use `Testing.synth(stack, true)` to assert `addValidation` errors and `Testing.fullSynth(stack)` (which also requires a provider construct for every resource type) to assert annotations in `manifest.json`. The test file shows all three.

## Production notes

- **Version your constructs like an API.** A change to a default (`retentionDays`) is a breaking change for every consumer's plan. Semver honestly; write a CHANGELOG entry that says which resources will show a diff.
- **Do not hide IAM.** `grant*` is convenience, not magic: document which role each method grants. A reviewer must be able to answer "who can read this bucket" from the construct's API docs.
- **Escape hatches must stay reachable.** Expose the underlying resource (`bucket.bucket`) so consumers can `addOverride` without forking the construct. Hiding it feels tidy and produces forks.
- **Validation is cheap; use it.** Every API-side rejection you can express as a synth-time check saves a failed apply. Keep the messages actionable (include the value and the rule).
- **Registry modules pin minors** (`~> 11.0`), never `>=`. A module major can rename outputs; your `getString('network_name')` would then fail at plan.
- **jsii compile time and package size** grow with the surface; keep the public API small and mark internals `@internal` or non-exported.

## Gotchas

- Symptom: `Testing.fullSynth` throws "Found resources without a matching provider construct" → cause: fullSynth runs stack validations; `synthScope`/`synth` do not → fix: add the provider in the test stack (or use `synth`).
- Symptom: nested resource ids change after moving a construct into another parent → cause: the hash covers the full path → fix: `moveTo`/`moveFromId` (module 02) or `overrideLogicalId` (module 01) in the same PR.
- Symptom: two `grantPublish()` calls collide with "There is already a Construct with name" → cause: same explicit id twice → fix: pass distinct ids, or let the construct generate them.
- Symptom: `module.getString('network_id')` plans with "Unsupported attribute" → cause: output name typo or module major changed → fix: check the module's `outputs.tf` for the pinned version; wrap outputs in typed properties so the typo lives in one place.
- Symptom: jsii compile error "Types in unions must be primitives or interfaces" → cause: TypeScript union of classes in a public prop → fix: accept an `I*` interface or a single class.
- Symptom: `cdktf get` fails offline or without Terraform → cause: it downloads modules through the Terraform binary → fix: prebuilt providers + `TerraformHclModule` for offline synth; run `cdktf get` only where the binary and network exist.
- Symptom: a CMEK bucket create fails with "permission denied on key" → cause: the GCS service agent's key grant does not exist yet or is on the wrong project's agent → fix: `SecureBucket` grants and `dependsOn`s it; make sure `project` is the bucket's project.

## Exercises

1. **`from*`.** Implement `importSecureBucket(scope, id, name): ISecureBucket` backed by a `google_storage_bucket` data source, with working `grant*`. Solution: [`solutions/01-imported-bucket.ts`](solutions/01-imported-bucket.ts).
2. **`EncryptionKey` construct.** Key ring (or an existing one), key with rotation validated to `[1, 365]` days and a warning above 90 in prod, HSM protection in HA tiers, `grantEncryptDecrypt(member)`/`grantViewer(member)`. Feed its key to `SecureBucket`. Solution: [`solutions/02-encryption-key.ts`](solutions/02-encryption-key.ts).
3. **Module composition.** `RegistryVpcWithNat`: the network module plus `terraform-google-modules/cloud-nat/google`, wired by output → variable and `dependsOn`, behind an `IVpc` interface. Solution: [`solutions/03-module-composition.ts`](solutions/03-module-composition.ts).

## Checklist

- [ ] Every construct has a `readonly` props interface with documented defaults and a `*Props` name.
- [ ] Behavioural contracts are `I*` interfaces; there is a `from*`/`import*` path for resources created elsewhere.
- [ ] `grant*` methods create `_iam_member`s in the construct scope and document the role.
- [ ] Hard rules use `node.addValidation`; policy uses `Annotations`; tokens are never validated as values.
- [ ] Underlying resources are exposed for escape hatches.
- [ ] Registry modules pin `~> major.minor`; outputs are read through typed wrapper properties.
- [ ] Code review: no `aws-cdk-lib` import anywhere under `cdktf-gcp/`; `@cdk-mastery/shared` imports only `constructs`.
- [ ] Code review (library): providers are peer deps; public API compiles under jsii.

## Interview angle

1. *"Construct or Terraform module — how do you decide?"* — Module when a maintained one encodes the opinions you want and HCL teams must share it; construct when the reuse is your rules or needs a runtime API (`grant*`, validation, composition); thin construct over a module when both. Constructs cannot be consumed from HCL; modules cannot validate at synth or grow after creation.
2. *"How do you validate a construct's inputs, and when does each check run?"* — TypeScript types at compile; `node.addValidation` and `Annotations` at synth (before Terraform; all errors reported together; tokens skipped); `variable.validation`/`precondition` at plan; the API at apply. Push every check as far left as the information allows.
3. *"Why can't I put an AWS CDK construct in a CDKTF app if they share `constructs`?"* — Shared tree, different everything else: synthesizers (Cloud Assembly vs `cdk.tf.json`), aspects (each framework visits only what it knows), tokens (different markers and resolvers). A foreign token becomes a literal string in the output. Shared code must depend only on `constructs`.

## References

- CDKTF constructs: https://developer.hashicorp.com/terraform/cdktf/concepts/constructs
- CDKTF modules (`TerraformHclModule`, generated bindings): https://developer.hashicorp.com/terraform/cdktf/concepts/modules
- CDKTF testing (`synthScope`, matchers): https://developer.hashicorp.com/terraform/cdktf/test/unit-tests
- Publishing construct libraries with projen: https://developer.hashicorp.com/terraform/cdktf/develop-custom-constructs/publishing-and-distribution
- projen `ConstructLibraryCdktf`: https://projen.io/docs/api/cdktf
- jsii type-system rules: https://aws.github.io/jsii/user-guides/lib-author/typescript-restrictions/
- AWS CDK design guidelines (the conventions borrowed here): https://github.com/aws/aws-cdk/blob/main/docs/DESIGN_GUIDELINES.md
- `terraform-google-modules/network/google`: https://registry.terraform.io/modules/terraform-google-modules/network/google/latest
- `terraform-google-modules/cloud-nat/google`: https://registry.terraform.io/modules/terraform-google-modules/cloud-nat/google/latest
- Cloud Storage CMEK: https://cloud.google.com/storage/docs/encryption/customer-managed-keys
- cdktf 0.21 source read for this module: `node_modules/cdktf/lib/private/unique.js` (`makeUniqueId`), `terraform-hcl-module.js`, `testing/index.js` (`synthScope`), `synthesize/synthesizer.js` (annotations)
