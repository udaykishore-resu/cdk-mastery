import * as fs from 'fs';
import * as path from 'path';
import { TerraformStack, Testing } from 'cdktf';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { IamWorkloadIdentityPool } from '@cdktf/provider-google/lib/iam-workload-identity-pool';
import { IamWorkloadIdentityPoolProvider } from '@cdktf/provider-google/lib/iam-workload-identity-pool-provider';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { ServiceAccountIamMember } from '@cdktf/provider-google/lib/service-account-iam-member';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { StorageBucketIamMember } from '@cdktf/provider-google/lib/storage-bucket-iam-member';
import {
  BackendDemoStack,
  DEPLOYER_PROJECT_ROLES,
  GITHUB_OIDC_ISSUER,
  PLANNER_PROJECT_ROLES,
  WifStack,
  backendFromEnv,
  githubAttributeCondition,
  roleToId,
} from '../src/modules/08-cicd-and-workload-identity';
import { bindDeployerToRef, refPrincipalSet } from '../src/modules/08-cicd-and-workload-identity/solutions/ref-restricted-binding';
import { PlanOnlyDeployer } from '../src/modules/08-cicd-and-workload-identity/solutions/plan-only-deployer';
import { MultiEnvWifStack } from '../src/modules/08-cicd-and-workload-identity/solutions/multi-env-wif-stack';

Testing.setupJest();

const REPO = { githubOwner: 'example-org', githubRepo: 'cdk-mastery' };

function wif(extra: Partial<ConstructorParameters<typeof WifStack>[2]> = {}) {
  return new WifStack(Testing.app(), 'm08-wif', { ...REPO, project: 'demo', region: 'us-central1', ...extra });
}

describe('08 · WifStack', () => {
  test('pool + GitHub OIDC provider with attribute mapping and a single-repo condition', () => {
    const synth = Testing.synth(wif());
    expect(synth).toHaveResourceWithProperties(IamWorkloadIdentityPool, { workload_identity_pool_id: 'github' });
    expect(synth).toHaveResourceWithProperties(IamWorkloadIdentityPoolProvider, {
      workload_identity_pool_id: '${google_iam_workload_identity_pool.Pool.workload_identity_pool_id}',
      workload_identity_pool_provider_id: 'github-actions',
      oidc: { issuer_uri: GITHUB_OIDC_ISSUER },
      attribute_mapping: {
        'google.subject': 'assertion.sub',
        'attribute.repository': 'assertion.repository',
        'attribute.repository_owner': 'assertion.repository_owner',
        'attribute.ref': 'assertion.ref',
        'attribute.actor': 'assertion.actor',
      },
      attribute_condition: 'attribute.repository == "example-org/cdk-mastery"',
    });
  });

  test('deployer SA is impersonable only by the repository principalSet, and has no keys', () => {
    const stack = wif();
    const synth = Testing.synth(stack);
    const json = JSON.parse(synth);
    expect(synth).toHaveResourceWithProperties(ServiceAccount, { account_id: 'cdktf-deployer' });
    expect(synth).toHaveResourceWithProperties(ServiceAccountIamMember, {
      service_account_id: '${google_service_account.Deployer.name}',
      role: 'roles/iam.workloadIdentityUser',
      member: 'principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.Pool.name}/attribute.repository/example-org/cdk-mastery',
    });
    expect(stack.repositoryPrincipalSet).toMatch(/^principalSet:\/\/iam\.googleapis\.com\//);
    expect(json.resource.google_service_account_key).toBeUndefined();
  });

  test('project roles: exactly DEPLOYER_PROJECT_ROLES, no primitive roles, PascalCase ids', () => {
    const json = JSON.parse(Testing.synth(wif()));
    const members = Object.entries<{ role: string; member: string; project: string }>(json.resource.google_project_iam_member);
    expect(members.map(([, m]) => m.role).sort()).toEqual([...DEPLOYER_PROJECT_ROLES].sort());
    expect(members.every(([, m]) => m.member === '${google_service_account.Deployer.member}' && m.project === 'demo')).toBe(true);
    expect(DEPLOYER_PROJECT_ROLES).not.toContain('roles/owner');
    expect(DEPLOYER_PROJECT_ROLES).not.toContain('roles/editor');
    for (const [id] of members) expect(id).toMatch(/^DeployerRole[A-Z][A-Za-z0-9]*$/);
    expect(roleToId('roles/resourcemanager.projectIamAdmin')).toBe('ResourcemanagerProjectIamAdmin');
  });

  test('outputs are exactly what google-github-actions/auth@v2 needs', () => {
    const json = JSON.parse(Testing.synth(wif({ stateBucket: { name: 'tf-state-demo' } })));
    expect(json.output.workload_identity_provider.value).toBe('${google_iam_workload_identity_pool_provider.GithubProvider.name}');
    expect(json.output.service_account.value).toBe('${google_service_account.Deployer.email}');
    expect(json.output.state_bucket.value).toBe('tf-state-demo');
  });

  test('state bucket: created with versioning + prevent_destroy when create=true, only bound otherwise', () => {
    const created = Testing.synth(wif({ stateBucket: { name: 'tf-state-demo', create: true } }));
    expect(created).toHaveResourceWithProperties(StorageBucket, {
      name: 'tf-state-demo',
      versioning: { enabled: true },
      public_access_prevention: 'enforced',
      lifecycle: { prevent_destroy: true },
    });
    expect(created).toHaveResourceWithProperties(StorageBucketIamMember, {
      bucket: '${google_storage_bucket.StateBucket.name}',
      role: 'roles/storage.objectAdmin',
      member: '${google_service_account.Deployer.member}',
    });
    const bound = Testing.synth(wif({ stateBucket: { name: 'existing-bucket' } }));
    expect(bound).not.toHaveResource(StorageBucket);
    expect(bound).toHaveResourceWithProperties(StorageBucketIamMember, { bucket: 'existing-bucket' });
  });

  test('every stack synthesizes fully', () => {
    expect(() => Testing.fullSynth(wif({ stateBucket: { name: 'b', create: true } }))).not.toThrow();
    expect(() => Testing.fullSynth(new BackendDemoStack(Testing.app(), 'm08-backend-demo', { tier: 'dev', project: 'demo' }))).not.toThrow();
  });
});

describe('08 · attribute condition builder', () => {
  test('repository only, and repository + refs', () => {
    expect(githubAttributeCondition({ repository: 'o/r' })).toBe('attribute.repository == "o/r"');
    expect(githubAttributeCondition({ repository: 'o/r', refs: ['refs/heads/main', 'refs/tags/v1'] })).toBe(
      'attribute.repository == "o/r" && attribute.ref in ["refs/heads/main", "refs/tags/v1"]',
    );
  });
});

describe('08 · backends', () => {
  test('backendFromEnv prefers GCS, then HCP Terraform, then local', () => {
    expect(backendFromEnv('m08-x', {})).toEqual({ kind: 'local' });
    expect(backendFromEnv('m08-x', { CDKM_STATE_BUCKET: 'b' })).toEqual({ kind: 'gcs', bucket: 'b', prefix: 'cdk-mastery/m08-x' });
    expect(backendFromEnv('m08-x', { CDKM_TFC_ORG: 'acme' })).toEqual({ kind: 'cloud', organization: 'acme', workspace: 'm08-x' });
    expect(backendFromEnv('m08-x', { CDKM_STATE_BUCKET: 'b', CDKM_TFC_ORG: 'acme' }).kind).toBe('gcs');
  });

  test('GcsBackend renders terraform.backend.gcs', () => {
    const json = JSON.parse(Testing.synth(new BackendDemoStack(Testing.app(), 'm08-backend-demo', { tier: 'dev', project: 'demo', backend: { kind: 'gcs', bucket: 'b', prefix: 'p' } })));
    expect(json.terraform.backend).toEqual({ gcs: { bucket: 'b', prefix: 'p' } });
  });

  test('CloudBackend renders the terraform.cloud block (HCP Terraform), named or tagged workspaces', () => {
    const named = JSON.parse(Testing.synth(new BackendDemoStack(Testing.app(), 'm08-backend-demo', { tier: 'dev', project: 'demo', backend: { kind: 'cloud', organization: 'acme', workspace: 'orders-prod' } })));
    expect(named.terraform.backend).toBeUndefined();
    expect(named.terraform.cloud).toEqual({ organization: 'acme', workspaces: { name: 'orders-prod' } });

    const tagged = JSON.parse(
      Testing.synth(new BackendDemoStack(Testing.app(), 'm08-backend-demo', { tier: 'dev', project: 'demo', backend: { kind: 'cloud', organization: 'acme', workspace: { tags: ['orders', 'prod'] }, hostname: 'tfe.example.com' } })),
    );
    expect(tagged.terraform.cloud).toEqual({ organization: 'acme', hostname: 'tfe.example.com', workspaces: { tags: ['orders', 'prod'] } });
  });

  test('local backend is explicit when requested', () => {
    const json = JSON.parse(Testing.synth(new BackendDemoStack(Testing.app(), 'm08-backend-demo', { tier: 'dev', project: 'demo', backend: { kind: 'local' } })));
    expect(json.terraform.backend.local).toBeDefined();
  });
});

describe('08 · the example workflow file', () => {
  const file = path.resolve(__dirname, '../src/modules/08-cicd-and-workload-identity/.github-workflows-example/cdktf-deploy.yml');
  const yml = fs.readFileSync(file, 'utf8');

  test('uses WIF (id-token: write + google-github-actions/auth@v2 with provider + service account), never a key', () => {
    expect(yml).toMatch(/id-token: write/);
    expect(yml).toMatch(/google-github-actions\/auth@v2/);
    expect(yml).toMatch(/workload_identity_provider: \$\{\{ vars\.WORKLOAD_IDENTITY_PROVIDER \}\}/);
    expect(yml).toMatch(/service_account: \$\{\{ vars\.DEPLOYER_SERVICE_ACCOUNT \}\}/);
    expect(yml).not.toMatch(/credentials_json/);
    expect(yml).not.toMatch(/GOOGLE_CREDENTIALS/);
  });

  test('plan on pull_request with a PR comment, deploy with --auto-approve on main, scheduled drift with -detailed-exitcode, concurrency', () => {
    expect(yml).toMatch(/hashicorp\/setup-terraform@v3/);
    expect(yml).toMatch(/terraform_wrapper: false/);
    expect(yml).toMatch(/npx cdktf diff/);
    expect(yml).toMatch(/npx cdktf synth/);
    expect(yml).toMatch(/createComment|updateComment/);
    expect(yml).toMatch(/npx cdktf deploy "\$s" --auto-approve/);
    expect(yml).toMatch(/environment: prod/);
    expect(yml).toMatch(/schedule:\n\s+- cron:/);
    expect(yml).toMatch(/plan -input=false -lock=false -detailed-exitcode/);
    expect(yml).toMatch(/concurrency:\n\s+group: cdktf-/);
    expect(yml).toMatch(/CDKM_STATE_BUCKET: \$\{\{ vars\.STATE_BUCKET \}\}/);
    expect(yml).toMatch(/conftest/);
  });
});

describe('08 · exercise solutions', () => {
  test('1. ref-restricted binding: only refs/heads/main may impersonate the deployer', () => {
    const stack = wif();
    const binding = bindDeployerToRef(stack, 'MainOnly', stack.pool, stack.deployer);
    const synth = Testing.synth(stack);
    expect(synth).toHaveResourceWithProperties(ServiceAccountIamMember, {
      member: 'principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.Pool.name}/attribute.ref/refs/heads/main',
    });
    expect(binding.memberInput).toMatch(/^principalSet:\/\/iam\.googleapis\.com\/\$\{TfToken\[TOKEN\.\d+\]\}\/attribute\.ref\/refs\/heads\/main$/); // token before synth
    expect(refPrincipalSet(stack.pool, 'refs/tags/v1')).toMatch(/\/attribute\.ref\/refs\/tags\/v1$/);
    expect(() => bindDeployerToRef(stack, 'Bad', stack.pool, stack.deployer, 'main')).toThrow(/fully qualified/);
  });

  test('2. plan-only deployer: viewer roles, objectViewer on state, bound to the repository', () => {
    const app = Testing.app();
    const stack = new TerraformStack(app, 'planner');
    new GoogleProvider(stack, 'Google', { project: 'demo' });
    const pool = new IamWorkloadIdentityPool(stack, 'Pool', { workloadIdentityPoolId: 'github' });
    new PlanOnlyDeployer(stack, 'Planner', { project: 'demo', pool, repository: 'o/r', stateBucket: 'tf-state' });
    const synth = Testing.synth(stack);
    const json = JSON.parse(synth);
    const roles = Object.values<{ role: string }>(json.resource.google_project_iam_member).map((m) => m.role).sort();
    expect(roles).toEqual([...PLANNER_PROJECT_ROLES].sort());
    expect(roles.some((r) => r.endsWith('admin') || r.endsWith('Admin'))).toBe(false);
    expect(synth).toHaveResourceWithProperties(StorageBucketIamMember, { bucket: 'tf-state', role: 'roles/storage.objectViewer' });
    expect(synth).toHaveResourceWithProperties(ServiceAccountIamMember, {
      member: 'principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.Pool.name}/attribute.repository/o/r',
    });
  });

  test('3. per-environment deployers bound to GitHub environments', () => {
    const stack = new MultiEnvWifStack(Testing.app(), 'm08-wif-envs', {
      ...REPO,
      project: 'seed',
      projects: { dev: 'orders-dev', staging: 'orders-staging', prod: 'orders-prod' },
      environments: ['dev', 'prod'],
    });
    const synth = Testing.synth(stack);
    const json = JSON.parse(synth);
    expect(synth).toHaveResourceWithProperties(IamWorkloadIdentityPoolProvider, {
      attribute_mapping: expect.objectContaining({ 'attribute.environment': 'assertion.environment' }),
    });
    expect(Object.keys(stack.deployers)).toEqual(['dev', 'prod']);
    expect(stack.deployers.prod.principalSet).toMatch(/\/attribute\.environment\/prod$/);
    expect(synth).toHaveResourceWithProperties(ServiceAccountIamMember, {
      service_account_id: '${google_service_account.DeployerProd.name}',
      member: 'principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.Pool.name}/attribute.environment/prod',
    });
    expect(synth).toHaveResourceWithProperties(ServiceAccount, { account_id: 'cdktf-deployer-prod', description: expect.stringContaining('reviewer approval') });
    // prod roles land in the prod project, dev roles in the dev project
    const members = Object.values<{ project: string; member: string }>(json.resource.google_project_iam_member);
    expect(members.filter((m) => m.member.includes('DeployerProd')).every((m) => m.project === 'orders-prod')).toBe(true);
    expect(members.filter((m) => m.member.includes('DeployerDev')).every((m) => m.project === 'orders-dev')).toBe(true);
    expect(members).toHaveLength(DEPLOYER_PROJECT_ROLES.length * 2);
    expect(json.output.service_account_prod.value).toBe('${google_service_account.DeployerProd.email}');
    expect(() => Testing.fullSynth(stack)).not.toThrow();
  });
});
