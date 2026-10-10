# Cheatsheet

> Practical reference, AWS CDK on the left, CDKTF on the right, for `aws-cdk-lib` 2.269.0 / CLI 2.1141.0 and `cdktf` 0.21.0 / `@cdktf/provider-google` 16.12.1. Flags listed are the ones that matter in production; run `--help` for the rest. Concepts: [ROSETTA-STONE](ROSETTA-STONE.md). Failure modes: [GOTCHAS](GOTCHAS.md).

## 1. First ten minutes on a new macOS machine

```bash
# Node via nvm (this repo pins Node 22 in .nvmrc; CDK/CDKTF need >= 20)
brew install nvm && mkdir -p ~/.nvm            # then add the nvm lines to ~/.zshrc
nvm install 22 && nvm use 22 && corepack enable

# CLIs (global is fine for laptops; CI should use the repo's pinned devDependencies via npx)
npm i -g aws-cdk@2.1141.0 cdktf-cli@0.21.0

# Terraform / OpenTofu version manager (pick one)
brew install tenv && tenv tofu install 1.9.1 && tenv tofu use 1.9.1      # or: tenv tf install 1.9.8
# brew install tfenv && tfenv install 1.9.8 && tfenv use 1.9.8            # alternative
# brew install opentofu                                                    # single version

# Cloud CLIs
brew install awscli && aws configure sso           # SSO profiles; never long-lived keys on a laptop
brew install --cask google-cloud-sdk && gcloud init && gcloud auth application-default login

# Optional but worth it
brew install jq yq conftest checkov trivy          # policy/scan tooling for plan JSON and templates

# This repo
git clone <repo> cdk-mastery && cd cdk-mastery && nvm use && npm ci && npm test
cd aws-cdk   && npx cdk ls                          # no credentials needed for env-agnostic stacks
cd ../cdktf-gcp && npx cdktf synth                  # no credentials, no terraform binary needed
```

Sanity checks: `cdk doctor` (prints versions/env), `cdktf debug` (versions, binary, providers), `aws sts get-caller-identity`, `gcloud auth list`, `terraform version` / `tofu version`.

## 2. CLI commands with the flags that matter

| Task | AWS CDK | CDKTF |
|---|---|---|
| Scaffold | `cdk init app --language typescript` | `cdktf init --template typescript --providers hashicorp/google@~>6.50 [--local]` |
| List | `cdk ls [--long]` | `cdktf list` |
| Synthesize | `cdk synth [STACK] [--quiet] [-o DIR] [-c k=v] [--lookups=false] [--strict]` | `cdktf synth [--hcl] [-o DIR]` |
| Preview | `cdk diff [STACKS] [--change-set\|--no-change-set] [--template FILE] [--fail]` (exit 1 on differences only with `--fail`) | `cdktf diff [STACK] [--refresh-only] [--var k=v] [--var-file f] [--no-color] [--skip-synth]` |
| Deploy | `cdk deploy [STACKS\|--all] [--exclusively] [--require-approval never] [--method change-set\|direct\|prepare-change-set\|execute-change-set] [--concurrency N] [--outputs-file f] [--no-rollback] [--hotswap\|--hotswap-fallback] [--ci] [--progress events] [--parameters K=V] [--notification-arns ARN] [--import-existing-resources] [--force]` | `cdktf deploy [STACKS\|'*'] [--auto-approve] [--parallelism N] [--terraform-parallelism N] [--ignore-missing-stack-dependencies] [--outputs-file f] [--outputs-file-include-sensitive-outputs] [--migrate-state] [--skip-synth] [--skip-provider-lock] [--var k=v]` |
| Destroy | `cdk destroy [STACKS] [--force] [--exclusively]` | `cdktf destroy [STACKS] [--auto-approve] [--parallelism N]` |
| Outputs | `cdk deploy --outputs-file out.json` | `cdktf output [STACK] [--outputs-file f] [--outputs-file-include-sensitive-outputs]` |
| Watch (dev) | `cdk watch [STACK]` (= `deploy --watch --hotswap-fallback`; `cdk.json` `watch.include/exclude`) | `cdktf watch [STACK]` (experimental; auto-deploys) |
| Bootstrap | `cdk bootstrap aws://ACCT/REGION [--qualifier Q] [--trust ACCT] [--trust-for-lookup ACCT] [--cloudformation-execution-policies ARN] [--custom-permissions-boundary NAME] [--bootstrap-customer-key] [--termination-protection] [--show-template] [--template f.yaml]` | — (create the state bucket; see §4) |
| Import | `cdk import [STACK] [--resource-mapping f.json \| --resource-mapping-inline JSON \| --record-resource-mapping f.json] [--force]` | code: `res.importFrom('id')` then `cdktf deploy`; or `cd cdktf.out/stacks/ID && terraform import ADDR ID` |
| Refactor/move | `cdk refactor --unstable=refactor [--dry-run] [--override-file f.json] [--additional-stack-name S] [--revert]` | code: `res.moveTo('t')`/`moveToId('type.old')` then `cdktf deploy`; or `terraform state mv` |
| Orphan | `cdk orphan --unstable=orphan Stack/Path [...]` | `stack.addOverride('removed', ...)` or `terraform state rm ADDR` |
| Rollback | `cdk rollback [STACK] [--orphan LOGICALID] [--force]` | — (re-run; no rollback concept) |
| Drift | `cdk drift [STACK] [--fail] [--verbose]` | `cdktf diff --refresh-only`; `terraform plan -refresh-only -detailed-exitcode` |
| Migrate in | `cdk migrate --stack-name X (--from-path t.yaml \| --from-stack \| --from-scan new\|most-recent) [--filter k=v] [--language ts] [--output-path DIR]` | `cdktf convert [--language typescript] [--stack] < main.tf`; `cdktf init --from-terraform-project DIR` |
| Bindings | — | `cdktf get [--force] [-o .gen]`; `cdktf provider add hashicorp/google [--force-local]`; `cdktf provider list`; `cdktf provider upgrade` |
| Context | `cdk context [--clear \| --reset KEY] [-j]` | `cdktf.json` `context`, `CDKTF_CONTEXT_JSON` |
| GC | `cdk gc --unstable=gc [aws://ACCT/REGION] [--action print\|tag\|delete-tagged\|full] [--type s3\|ecr\|all] [--rollback-buffer-days N] [--created-buffer-days N] [--confirm=false]` | bucket lifecycle rule on assets |
| Flags | `cdk flags --unstable=flags [FLAG] [--set --value v] [--recommended]` | — |
| Validate | `cdk validate --unstable=validate`; `cdk synth --strict` | `terraform validate` inside the stack dir (matcher `toBeValidTerraform`) |
| Diagnose | `cdk diagnose --unstable=diagnose STACK`; `cdk doctor`; `-v -v`; `--debug-app` | `cdktf debug`; `CDKTF_LOG_LEVEL=debug`; `TF_LOG=DEBUG` |
| Notices | `cdk notices`; `cdk acknowledge ID` | — |
| Login | `aws sso login --profile p`; `cdk --profile p` | `cdktf login` (HCP Terraform); `gcloud auth application-default login` |
| Editor/AI | `cdk lsp` | — |
| Assets only | `cdk publish-assets [STACKS]` | — |

Reuse a synthesized assembly (CI): `cdk synth -o cdk.out` once, then `cdk deploy --app cdk.out STACK` / `cdk diff --app cdk.out`. CDKTF: `cdktf synth` once, then `cdktf deploy --skip-synth`, or run `terraform` directly in `cdktf.out/stacks/<id>`.

Stack selection: both accept globs (`'prod-*'`); CDK also `--all`, CDKTF `'*'`. Stack ids inside a `Stage` are paths (`Prod/Orders/Api`).

## 3. Environment variables

| Variable | Effect |
|---|---|
| **AWS CDK** | |
| `CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION` | Set *by the CLI* for the app from the current credentials/`--profile`/`--region`; use as `env` only for sandboxes. |
| `CDK_OUTDIR` | Set by the CLI; where `app.synth()` writes. `App({ outdir })` overrides. |
| `CDK_CONTEXT_JSON` | Set by the CLI: merged context (`cdk.json`, `~/.cdk.json`, `-c`, `cdk.context.json`). |
| `CDK_DEBUG=true` | Record construct creation stack traces (`--debug-app` sets it); slows synth. |
| `CDK_DISABLE_STACK_TRACE` | Opposite: omit stack traces from metadata. |
| `CDK_DISABLE_VERSION_CHECK`, `CDK_DISABLE_CLI_TELEMETRY`, `CDK_NOTICES_TIMEOUT` | CI hygiene. |
| `CDK_HOME` | Where the CLI caches (`~/.cdk` default). |
| `CDK_DOCKER` | Alternative Docker-compatible binary for bundling (`finch`, `podman`). |
| `CDK_BLOCK_DEPRECATIONS=1` | Throw on deprecated API use (great in CI for a library). |
| `CDK_ROLE_SESSION_NAME` | Session name when assuming bootstrap roles (audit trails). |
| `AWS_PROFILE`, `AWS_REGION`/`AWS_DEFAULT_REGION`, `AWS_CA_BUNDLE`, `AWS_ENDPOINT_URL*` | Standard SDK variables; the CLI honours them. |
| `JSII_DEBUG=1`, `JSII_SILENCE_WARNING_*` | jsii runtime diagnostics / silence deprecation warnings. |
| `TS_NODE_TRANSPILE_ONLY=1` | Skip type-checking in `ts-node` for faster synth. |
| **CDKTF** | |
| `CDKTF_OUTDIR` | Set by the CLI for the app; `App({ outdir })` overrides. |
| `CDKTF_CONTEXT_JSON` | Context injected into the app (JSON string). |
| `CDKTF_LOG_LEVEL=debug\|info\|warn\|error`, `CDKTF_LOG_FILE_DIRECTORY` | CLI logging (the `--log-level` flag only works via the env var). |
| `CDKTF_HOME` | Cache directory. |
| `CDKTF_DISABLE_PLUGIN_CACHE_ENV=1` | Do not set `TF_PLUGIN_CACHE_DIR` automatically. |
| `CDKTF_EXPERIMENTAL_PROVIDER_SCHEMA_CACHE_PATH` | Speeds repeated `cdktf get`/`convert`. |
| `CDKTF_TARGET_STACK_ID` | Set by the CLI when a single stack is targeted (apps can skip constructing others). |
| `CDKTF_CONTINUE_SYNTH_ON_ERROR_ANNOTATIONS` | Do not abort synth on `Annotations.addError` (for inspection only). |
| `SYNTH_HCL_OUTPUT=true` | Same as `--hcl` / `App({ hclOutput: true })`. |
| `TERRAFORM_BINARY_NAME=tofu` | Use OpenTofu (or any path) instead of `terraform`. |
| `DISABLE_VERSION_CHECK=1`, `CHECKPOINT_DISABLE=1` | No update checks (CDKTF / Terraform). |
| `CI=true` | Non-interactive rendering. |
| **Terraform (inherited by CDKTF)** | |
| `TF_LOG=TRACE\|DEBUG\|INFO`, `TF_LOG_PATH`, `TF_LOG_PROVIDER` | Engine/provider logs. |
| `TF_VAR_name` | Sets `variable "name"` (a `TerraformVariable`). |
| `TF_PLUGIN_CACHE_DIR` | Provider cache (CDKTF sets it). |
| `TF_IN_AUTOMATION=1`, `TF_INPUT=0` | CI mode. |
| `TF_TOKEN_app_terraform_io` | HCP Terraform token (also for `CloudBackend`). |
| `TF_WORKSPACE`, `TF_DATA_DIR`, `TF_CLI_ARGS`, `TF_CLI_ARGS_plan` | Workspace/data dir/extra args. |
| **Google auth (provider and backend)** | |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a credentials JSON — service-account key (avoid) or the ADC file written by `gcloud auth application-default login` / WIF `auth` action. |
| `GOOGLE_CREDENTIALS` | Credentials JSON *contents* (CI secret); `GOOGLE_CLOUD_KEYFILE_JSON`, `GCLOUD_KEYFILE_JSON` are legacy aliases. |
| `GOOGLE_OAUTH_ACCESS_TOKEN` | Short-lived token (what WIF actions export). |
| `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` | Provider impersonation (equivalent to `impersonateServiceAccount`). |
| `GOOGLE_PROJECT`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, `CLOUDSDK_CORE_PROJECT` | Default project (in that precedence order for the provider). |
| `GOOGLE_REGION`, `GOOGLE_ZONE`, `GOOGLE_BILLING_PROJECT`, `USER_PROJECT_OVERRIDE` | Defaults/quota project. |
| `GOOGLE_BACKEND_CREDENTIALS`, `GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT` | Same for the GCS backend, when it must differ from the provider. |

## 4. Bootstrap and backend setup

```bash
# AWS: one per (account, region). Repeat with --trust for every env the pipeline account deploys to.
cdk bootstrap aws://111111111111/us-east-1 \
  --qualifier plat01 \
  --trust 999999999999 --trust-for-lookup 999999999999 \
  --cloudformation-execution-policies arn:aws:iam::111111111111:policy/cdk-exec-boundary-scoped \
  --custom-permissions-boundary cdk-workload-boundary \
  --bootstrap-customer-key --termination-protection
# App side (or "@aws-cdk/core:bootstrapQualifier": "plat01" in cdk.json context):
new cdk.Stack(app, 'X', { env, synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: 'plat01' }) });
# Inspect / customise the template
cdk bootstrap --show-template > bootstrap.yaml   # edit, then: cdk bootstrap --template bootstrap.yaml ...
```

```bash
# GCP: the state bucket, once per environment class (do it with gcloud or a tiny local-backend bootstrap stack)
gcloud storage buckets create gs://platform-prod-tfstate --project platform-prod --location EU \
  --uniform-bucket-level-access --public-access-prevention --default-storage-class STANDARD
gcloud storage buckets update gs://platform-prod-tfstate --versioning
gcloud storage buckets update gs://platform-prod-tfstate --default-encryption-key projects/platform-prod/locations/eu/keyRings/tf/cryptoKeys/state
gcloud storage buckets add-iam-policy-binding gs://platform-prod-tfstate \
  --member serviceAccount:cdktf-apply@platform-prod.iam.gserviceaccount.com --role roles/storage.objectAdmin
```

```ts
// CDKTF stack side
new GcsBackend(this, { bucket: 'platform-prod-tfstate', prefix: `orders/${id}`, kmsEncryptionKey: '...' });
// HCP Terraform instead:
new CloudBackend(this, { organization: 'acme', workspaces: new NamedCloudWorkspace(`orders-${id}`) });
// Provider with impersonation and quota project
new GoogleProvider(this, 'google', { project, region, impersonateServiceAccount: 'cdktf-apply@...', userProjectOverride: true, billingProject: project });
new GoogleBetaProvider(this, 'google-beta', { project, region, alias: 'beta' });   // beta resources: `provider: beta`
```

Workload Identity Federation for GitHub (GCP), the resources you need (module B08 has the construct):

```ts
const pool = new IamWorkloadIdentityPool(this, 'gh', { workloadIdentityPoolId: 'github' });
const provider = new IamWorkloadIdentityPoolProvider(this, 'gh-oidc', {
  workloadIdentityPoolId: pool.workloadIdentityPoolId, workloadIdentityPoolProviderId: 'github',
  oidc: { issuerUri: 'https://token.actions.githubusercontent.com' },
  attributeMapping: { 'google.subject': 'assertion.sub', 'attribute.repository': 'assertion.repository', 'attribute.ref': 'assertion.ref' },
  attributeCondition: `assertion.repository_owner == 'acme'`,
});
new ServiceAccountIamMember(this, 'gh-impersonate', {
  serviceAccountId: applySa.name, role: 'roles/iam.workloadIdentityUser',
  member: `principalSet://iam.googleapis.com/${pool.name}/attribute.repository/acme/platform`,
});
```

OIDC for GitHub (AWS): an `iam.OpenIdConnectProvider` for `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`), a `iam.Role` with `WebIdentityPrincipal` conditioned on `token.actions.githubusercontent.com:sub` = `repo:acme/platform:ref:refs/heads/main`, allowed only `sts:AssumeRole` on `arn:aws:iam::*:role/cdk-plat01-*-role-*`.

## 5. Assertions APIs

```ts
// AWS CDK — aws-cdk-lib/assertions
const t = Template.fromStack(stack);                  // synthesizes the app; fresh App per test
t.resourceCountIs('AWS::SQS::Queue', 2);
t.resourcePropertiesCountIs('AWS::S3::Bucket', { VersioningConfiguration: { Status: 'Enabled' } }, 1);
t.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs22.x', Environment: { Variables: { TABLE: Match.anyValue() } } });
t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
t.allResourcesProperties('AWS::S3::Bucket', { PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }) });
t.hasOutput('BucketName', { Export: { Name: Match.stringLikeRegexp('.*-store-name') } });
t.hasParameter('BootstrapVersion', { Type: 'AWS::SSM::Parameter::Value<String>' });
t.hasCondition('IsProd', Match.anyValue());  t.hasMapping('RegionMap', Match.anyValue());
const res = t.findResources('AWS::IAM::Role', { Properties: { AssumeRolePolicyDocument: Match.objectLike({}) } });
const id = t.getResourceId('AWS::DynamoDB::Table');           // exactly one must match
t.templateMatches({ Resources: Match.objectLike({}) });
expect(t.toJSON()).toMatchSnapshot();
// Matchers
Match.objectLike({}); Match.objectEquals({}); Match.exact(x); Match.arrayWith([...]); Match.arrayEquals([...]);
Match.absent(); Match.anyValue(); Match.not(x); Match.stringLikeRegexp('^arn:'); Match.serializedJson({ ... });
// Capture
const c = new Capture(); t.hasResourceProperties('AWS::Lambda::Function', { Role: c });
c.asObject();  c.asString();  c.asArray();  c.next();   // next(): iterate multiple captures
// Annotations
Annotations.fromStack(stack).hasError('/Stack/Bucket', Match.stringLikeRegexp('CMEK'));
Annotations.fromStack(stack).hasNoWarning('*', Match.anyValue());
Annotations.fromStack(stack).findInfo('*', Match.anyValue());
// Resolve a token to its template form
expect(stack.resolve(bucket.bucketArn)).toEqual({ 'Fn::GetAtt': ['Artifacts82DD59A1', 'Arn'] });
```

```ts
// CDKTF — cdktf/lib/testing (+ import 'cdktf/lib/testing/adapters/jest' in setup)
const json = Testing.synth(stack, /* runValidations */ true);   // string; aspects run; validations optional
const scoped = Testing.synthScope(scope => { new MyConstruct(scope, 'x', props); });   // construct in isolation
const dir = Testing.fullSynth(stack);                            // writes a real cdktf.out for binary-backed matchers
expect(json).toHaveResource(StorageBucket);
expect(json).toHaveResourceWithProperties(StorageBucket, { uniform_bucket_level_access: true, versioning: [{ enabled: true }] });
expect(json).toHaveDataSourceWithProperties(DataGoogleProject, { project_id: 'p' });
expect(json).toHaveProviderWithProperties(GoogleProvider, { region: 'europe-west4' });
expect(json).not.toHaveResourceWithProperties(StorageBucketIamMember, { member: 'allUsers' });
expect(json).toMatchSnapshot();
expect(Testing.renderConstructTree(stack)).toMatchSnapshot();    // tree shape, not properties
if (process.env.RUN_TERRAFORM_TESTS) { expect(dir).toBeValidTerraform(); expect(dir).toPlanSuccessfully(); }
// Escape to plain JSON when matchers are too coarse
const cfg = JSON.parse(json); const buckets = cfg.resource.google_storage_bucket;
expect(Object.keys(buckets)).toEqual(['store']);                  // address stability test
// Framework-neutral matcher (deep subset, camel/snake tolerant)
Testing.toHaveResourceWithProperties(json, StorageBucket, { publicAccessPrevention: 'enforced' });
// Aspects/annotations
Testing.synth(stack, true);   // throws on Annotations.addError
```

## 6. Escape hatches you actually use

```ts
// AWS CDK
const cfn = bucket.node.defaultChild as s3.CfnBucket;            // the L1 under an L2
cfn.addPropertyOverride('NotificationConfiguration.EventBridgeConfiguration.EventBridgeEnabled', true);
cfn.addPropertyDeletionOverride('VersioningConfiguration');
cfn.addOverride('Metadata.cdk_nag', { rules_to_suppress: [] });
cfn.addDeletionOverride('Properties.Tags');
cfn.cfnOptions.condition = isProd; cfn.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
cfn.overrideLogicalId('LegacyBucket');  stack.renameLogicalId('Old', 'New');
cfn.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
new cdk.CfnResource(this, 'New', { type: 'AWS::Service::Brand::New', properties: { ... } });
stack.node.tryFindChild('Id'); stack.node.findChild('Id'); construct.node.tryRemoveChild('Id');
stack.templateOptions.description = '...'; stack.addTransform('AWS::LanguageExtensions');
cdk.Names.uniqueId(construct); cdk.Names.uniqueResourceName(construct, { maxLength: 64, separator: '-' });
Stack.of(this).exportValue(x); Stack.consumeReference(x, ReferenceStrength.WEAK); CrossStackReferences.of(x).produce(ReferenceStrength.WEAK);
cdk.Lazy.string({ produce: () => ... }); cdk.Token.isUnresolved(x); stack.toJsonString(obj); stack.resolve(x);
cdk.Annotations.of(this).addError('...'); cdk.Validations.of(this).addWarning('lib:Id', '...'); cdk.Validations.of(this).acknowledge({ id, reason });
cdk.Aspects.of(scope).add(aspect, { priority: cdk.AspectPriority.MUTATING });
cdk.Tags.of(scope).add('k', 'v', { excludeResourceTypes: ['AWS::Foo::Bar'], priority: 200 });
cdk.PropertyInjectors.of(scope).add(injector);                    // default props by construct uniqueId
```

```ts
// CDKTF
res.addOverride('lifecycle.ignore_changes', ['labels']);           // when the typed lifecycle does not fit
res.addOverride('template.0.containers.0.image', img);            // block indexes with .N.
res.addOverride('provisioner', [{ 'local-exec': { command: 'echo hi' } }]);
res.overrideLogicalId('legacy_bucket');  res.resetOverrideLogicalId();
res.importFrom('projects/p/buckets/b');  res.moveTo('t'); other.addMoveTarget('t'); res.moveToId('google_x.old'); res.moveFromId('google_x.old');
res.lifecycle = { preventDestroy: true, createBeforeDestroy: true, replaceTriggeredBy: [dep], precondition: [{ condition: ..., errorMessage: '...' }] };
res.dependsOn = [svc.fqn]; res.provider = betaProvider; res.count = TerraformCount.of(2); res.forEach = iterator;
stack.addOverride('terraform.required_version', '>= 1.9.0');
stack.addOverride('removed', [{ from: 'google_x.old', lifecycle: { destroy: false } }]);
backend.addOverride('use_lockfile', true);
new TerraformResource(this, 'raw', { terraformResourceType: 'google_new_thing', terraformGeneratorMetadata: { providerName: 'google' } }).addOverride('name', 'x');
new TerraformHclModule(this, 'net', { source: 'terraform-google-modules/network/google', version: '~> 10.0', variables: { ... } }).get('subnets');
Token.asString(x); Token.asList(x); Token.isUnresolved(x); Fn.jsonencode(obj); Fn.rawString('${literal}'); call('provider::google::name_from_id', [id]);
propertyAccess(list, [0, 'name']); conditional(cond, a, b); ref('google_x.y.id', stack);
TerraformIterator.fromMap(map); it.key; it.value; it.getString('name'); it.dynamic({ ... });
Lazy.stringValue({ produce: () => ... });
Annotations.of(this).addError('...'); Aspects.of(scope).add(aspect);
new DataResource(this, 'once', { triggersReplace: {...}, provisioners: [{ type: 'local-exec', command: '...' }] });
```

## 7. Files that matter

| AWS CDK | CDKTF |
|---|---|
| `cdk.json`: `app`, `watch`, `context` (feature flags, `bootstrapQualifier`), `requireApproval`, `progress`, `output`, `build`, `toolkitStackName` | `cdktf.json`: `language`, `app`, `output`, `codeMakerOutput` (`.gen`), `projectId`, `sendCrashReports`, `terraformProviders`, `terraformModules`, `context` |
| `cdk.context.json` (commit; lookup cache) | `.terraform.lock.hcl` inside `cdktf.out/stacks/<id>` (copy out if you want it pinned) |
| `cdk.out/` (gitignore): `manifest.json`, `*.template.json`, `*.assets.json`, `tree.json`, `validation-report.json`, `asset.*` | `cdktf.out/` (gitignore): `manifest.json`, `stacks/<id>/cdk.tf.json` (or `cdk.tf`), `assets/`, `plan` |
| `~/.cdk.json` (user defaults), `~/.cdk/` (cache, notices) | `~/.terraform.d/` (plugin cache, credentials), `$CDKTF_HOME` |

## 8. Ten habits

1. `cdk diff` / `cdktf diff` on every PR; read for `[-]`/`-/+` before anything else.
2. Concrete `env` / explicit provider+backend on every stack; `--lookups=false` in CI.
3. Pin `aws-cdk-lib` + CLI; pin `cdktf` + `cdktf-cli` + providers to the same minor; bump on a train with a reviewed diff.
4. `RemovalPolicy.RETAIN` / `deletionProtection`/`preventDestroy` from the environment tier, via an aspect.
5. Never `latest`, never `AdministratorAccess` on the exec role in prod, never JSON SA keys.
6. Tests run without credentials or binaries; gate the rest.
7. Keep `cdk.context.json` committed and refreshed on purpose; keep `.terraform.lock.hcl` reproducible.
8. One state file/stack per layer per environment; stateful things in their own stack.
9. Custom resources and provisioners are last resorts; make them idempotent and delete-safe.
10. Read the synthesized artefact, not just the code, when something looks wrong.
