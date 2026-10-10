/**
 * Exercise 2 — the workspace flavour, so you can see what stack-per-env buys.
 *
 * One stack, N Terraform workspaces (`terraform workspace select prod`, or
 * `TF_WORKSPACE=prod`). Every environment difference becomes a Terraform
 * expression on `terraform.workspace`. Build it, then answer: which of the
 * README's stack-per-environment tests can you still write?
 *
 * Answer: almost none. `force_destroy` is
 * `${!lookup(lookup(local.tiers, terraform.workspace, {}), "retain", true)}`
 * for every environment; the test cannot tell prod from dev because the
 * decision was moved out of TypeScript and into Terraform.
 */
import { Fn, Op, TerraformLocal, TerraformOutput, TerraformStack, TerraformVariable, Token, VariableType, ref } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import { configureBackend } from '../backend';
import { gcpProject, gcpRegion } from '../gcp-config';

export interface WorkspaceStackProps {
  readonly project?: string;
}

export class WorkspaceStack extends TerraformStack {
  readonly bucket: StorageBucket;

  constructor(scope: Construct, id: string, props: WorkspaceStackProps = {}) {
    super(scope, id);
    new GoogleProvider(this, 'Google', { project: props.project ?? gcpProject(), region: gcpRegion() });
    // With a GCS backend, workspaces are stored as `<prefix>/<workspace>.tfstate`
    // next to `<prefix>/default.tfstate`. One prefix, N files.
    configureBackend(this, 'workspace-demo');

    // The whole environment table, shipped to Terraform as a local so the
    // lookup can happen at plan time.
    const tiers = new TerraformLocal(
      this,
      'tiers',
      Object.fromEntries(
        Object.values(ENVIRONMENTS).map((t) => [
          t.name,
          { retain: t.retainStatefulResources, retention_days: t.logRetentionDays, cost_center: t.costCenter },
        ]),
      ),
    );
    const workspace = Token.asString(ref('terraform.workspace'));
    const tier = Fn.lookup(tiers.asAnyMap, workspace, {});

    // Guard: `default` is a real workspace and nobody wants prod config from a
    // typo. A variable with validation is the only place to fail early.
    const confirmedEnv = new TerraformVariable(this, 'environment', {
      type: VariableType.STRING,
      description: 'Must equal the selected workspace; guards against `terraform workspace select` mistakes.',
    });
    confirmedEnv.addValidation({
      condition: Fn.contains(Object.keys(ENVIRONMENTS), confirmedEnv.stringValue),
      errorMessage: `environment must be one of ${Object.keys(ENVIRONMENTS).join(', ')}`,
    });

    this.bucket = new StorageBucket(this, 'Data', {
      name: Fn.format('cdkm-state-%s-ws-data', [workspace]),
      location: 'US',
      uniformBucketLevelAccess: true,
      // Unknown workspace → retain (the safe default). Note `Fn.lookup` treats a
      // *falsy* default (false/0/"") as "no default" and renders `map.key`
      // instead of `lookup(map, key, default)` — same family of quirk as `Op.*`.
      forceDestroy: Op.not(Fn.lookup(tier, 'retain', true)),
      labels: { environment: workspace, 'cost-center': Fn.lookup(tier, 'cost_center', 'unknown') },
      lifecycleRule: [{ action: { type: 'Delete' }, condition: { age: Fn.lookup(tier, 'retention_days', 7) } }],
      lifecycle: {
        precondition: [
          {
            condition: Op.eq(workspace, confirmedEnv.stringValue),
            errorMessage: 'var.environment does not match terraform.workspace — refusing to apply.',
          },
        ],
      },
    });

    new TerraformOutput(this, 'workspace', { value: workspace });
  }
}
