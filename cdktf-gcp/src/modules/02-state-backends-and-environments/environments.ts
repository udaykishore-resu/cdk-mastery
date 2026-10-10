import { App, TerraformOutput, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { ENVIRONMENTS, EnvironmentTier, mandatoryTags, resourceName } from '@cdk-mastery/shared';
import { configureBackend, StateBackendOptions } from './backend';
import { gcpProject, gcpRegion } from './gcp-config';

export interface EnvironmentStackProps {
  readonly tier: EnvironmentTier;
  /** Each environment normally lives in its own project; default is the shared demo project. */
  readonly project?: string;
  readonly region?: string;
  readonly state?: StateBackendOptions;
}

/**
 * One TerraformStack per environment: its own `cdk.tf.json`, its own state
 * prefix (`env/<name>`), its own provider block (so its own project and
 * impersonated SA), its own `cdktf deploy m02-env-prod`. The tier drives every
 * difference in configuration, and because the tier is a TypeScript value,
 * tests can assert "prod retains buckets" without running Terraform.
 *
 * The alternative is Terraform *workspaces*: one configuration, N state files
 * selected with `terraform workspace select`, differences expressed as
 * `terraform.workspace == "prod" ? … : …` — all tokens, all invisible to
 * TypeScript, and one wrong `select` away from applying dev config to prod.
 * CDKTF supports workspaces (the CLI honours `TF_WORKSPACE`) but stack-per-env
 * is the idiom. Exercise 2 builds the workspace flavour so you can compare.
 */
export class EnvironmentStack extends TerraformStack {
  readonly bucket: StorageBucket;

  constructor(scope: Construct, id: string, props: EnvironmentStackProps) {
    super(scope, id);
    const tier = props.tier;
    new GoogleProvider(this, 'Google', { project: props.project ?? gcpProject(), region: props.region ?? gcpRegion() });
    configureBackend(this, `env/${tier.name}`, props.state);

    this.bucket = new StorageBucket(this, 'Data', {
      name: resourceName({ org: 'cdkm', service: 'state', env: tier.name, component: 'data' }),
      location: 'US',
      uniformBucketLevelAccess: true,
      publicAccessPrevention: 'enforced',
      versioning: { enabled: tier.retainStatefulResources },
      forceDestroy: !tier.retainStatefulResources,
      // Dual-region-ish resilience only where the tier pays for it.
      storageClass: tier.highlyAvailable ? 'STANDARD' : 'NEARLINE',
      lifecycleRule: [{ action: { type: 'Delete' }, condition: { age: tier.logRetentionDays, withState: 'ARCHIVED' } }],
      labels: mandatoryTags(tier, 'state'),
      lifecycle: { preventDestroy: tier.retainStatefulResources },
    });

    new TerraformOutput(this, 'bucket_name', { value: this.bucket.name });
  }
}

/** Stack-per-environment factory. Stack ids: `m02-env-dev`, `m02-env-staging`, `m02-env-prod`. */
export function addEnvironmentStacks(app: App, idPrefix = 'm02-env'): Record<string, EnvironmentStack> {
  const stacks: Record<string, EnvironmentStack> = {};
  for (const tier of Object.values(ENVIRONMENTS)) {
    stacks[tier.name] = new EnvironmentStack(app, `${idPrefix}-${tier.name}`, { tier });
  }
  return stacks;
}
