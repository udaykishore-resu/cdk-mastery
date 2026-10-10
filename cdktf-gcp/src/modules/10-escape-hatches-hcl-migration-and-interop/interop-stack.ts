import * as path from 'path';
import { AssetType, DataTerraformRemoteStateGcs, Fn, TerraformAsset, TerraformHclModule, TerraformOutput, TerraformStack, TerraformVariable, VariableType } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { BigqueryDataset } from '@cdktf/provider-google/lib/bigquery-dataset';
import { BigqueryTable } from '@cdktf/provider-google/lib/bigquery-table';
import { StorageBucketIamMember } from '@cdktf/provider-google/lib/storage-bucket-iam-member';
import { StorageBucketObject } from '@cdktf/provider-google/lib/storage-bucket-object';
import { environmentFor, mandatoryTags, resourceName } from '@cdk-mastery/shared';
import { gcpProject, gcpRegion } from './gcp-config';

export interface InteropStackProps {
  readonly tier: string;
  readonly project?: string;
  readonly region?: string;
  /** Bucket + prefix of the *legacy* HCL stack's state (legacy/main.tf's backend). */
  readonly legacyState?: { readonly bucket: string; readonly prefix: string };
  /** Pin the asset hash for snapshot-stable tests. */
  readonly assetHash?: string;
}

/**
 * Living next to HCL and to Terraform-only teams:
 *
 *   DataTerraformRemoteStateGcs  read outputs of a stack you do not own (the migration bridge)
 *   TerraformHclModule           consume a Registry module without generated bindings
 *   TerraformAsset               ship a file (a BigQuery schema) with the stack
 *   TerraformVariable            accept input at plan time (`TF_VAR_*`, `*.auto.tfvars`)
 *   cdktf synth --hcl            hand the result to an HCL-only team (README)
 */
export class InteropStack extends TerraformStack {
  readonly legacy: DataTerraformRemoteStateGcs;
  readonly network: TerraformHclModule;
  readonly schema: TerraformAsset;
  readonly dataset: BigqueryDataset;

  constructor(scope: Construct, id: string, props: InteropStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    const project = props.project ?? gcpProject();
    const region = props.region ?? gcpRegion();
    new GoogleProvider(this, 'Google', { project, region });
    const labels = mandatoryTags(tier, 'interop');

    // -- A variable with no default: must arrive at plan time. ----------------
    // `TF_VAR_dataset_owner=... cdktf deploy m10-interop`, or drop a
    // `*.auto.tfvars` into cdktf.out/stacks/m10-interop/ *after* synth (synth
    // recreates the directory). Variables are the right tool for values that
    // differ per operator run; for values that differ per environment, use
    // TypeScript config and synthesize per environment instead.
    const datasetOwner = new TerraformVariable(this, 'DatasetOwner', {
      type: VariableType.STRING,
      description: 'Email of the group that owns the analytics dataset (group:...)',
    });
    datasetOwner.overrideLogicalId('dataset_owner');

    // -- Remote state: the migration bridge. ---------------------------------
    // legacy/main.tf still owns the assets bucket. Until it is migrated, read
    // its outputs instead of re-declaring the bucket. No import, no shared
    // state: two root modules, one directed dependency. Requires the reader to
    // have objectViewer on the state bucket (state contains secrets; scope it).
    this.legacy = new DataTerraformRemoteStateGcs(this, 'Legacy', {
      bucket: props.legacyState?.bucket ?? 'cdkm-tf-state',
      prefix: props.legacyState?.prefix ?? 'legacy/assets',
    });
    const legacyBucket = this.legacy.getString('assets_bucket');
    new StorageBucketIamMember(this, 'LegacyBucketReader', {
      bucket: legacyBucket,
      role: 'roles/storage.objectViewer',
      member: datasetOwner.stringValue,
    });

    // -- A Registry module without `cdktf get`. ------------------------------
    // TerraformHclModule renders a `module` block; variables are untyped
    // (`variables: Record<string, any>`) and outputs come back via `.get()` /
    // `.getString()`. Generated bindings (cdktf.json `terraformModules`) give
    // you types at the cost of a `cdktf get` step; for a module you call once,
    // this is the cheaper deal.
    this.network = new TerraformHclModule(this, 'Network', {
      source: 'terraform-google-modules/network/google',
      version: '~> 10.0',
      variables: {
        project_id: project,
        network_name: resourceName({ org: 'cdkm', service: 'interop', env: tier.name, component: 'vpc' }),
        routing_mode: 'GLOBAL',
        subnets: [{ subnet_name: `interop-${region}`, subnet_ip: '10.50.0.0/20', subnet_region: region, subnet_private_access: true }],
      },
    });
    new TerraformOutput(this, 'NetworkSelfLink', { value: this.network.getString('network_self_link') });

    // -- An asset: a BigQuery schema file shipped with the stack. ------------
    this.schema = new TerraformAsset(this, 'OrdersSchema', {
      path: path.resolve(__dirname, 'assets', 'schema', 'orders.json'),
      type: AssetType.FILE,
      assetHash: props.assetHash,
    });
    this.dataset = new BigqueryDataset(this, 'Analytics', {
      datasetId: `cdkm_interop_${tier.name}`,
      location: 'US',
      labels,
      deleteContentsOnDestroy: !tier.retainStatefulResources,
    });
    new BigqueryTable(this, 'Orders', {
      datasetId: this.dataset.datasetId,
      tableId: 'orders',
      // `file()` reads the asset at plan time from the synthesized directory
      // (the path is relative to it). `jsonencode(jsondecode(...))` normalises
      // whitespace so a reformat of the JSON file does not show as a change.
      schema: Fn.jsonencode(Fn.jsondecode(Fn.file(this.schema.path))),
      deletionProtection: tier.retainStatefulResources,
      labels,
    });
    new StorageBucketObject(this, 'SchemaCopy', {
      bucket: legacyBucket,
      name: `schemas/orders/${this.schema.fileName}`,
      source: this.schema.path,
    });
  }
}
