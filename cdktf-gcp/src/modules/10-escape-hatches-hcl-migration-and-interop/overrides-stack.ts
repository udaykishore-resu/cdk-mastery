import { Fn, TerraformOutput, TerraformResource, TerraformStack, call } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { CloudRunV2Service } from '@cdktf/provider-google/lib/cloud-run-v2-service';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { SqlDatabaseInstance } from '@cdktf/provider-google/lib/sql-database-instance';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { environmentFor, resourceName } from '@cdk-mastery/shared';
import { gcpProject, gcpRegion } from './gcp-config';

export interface OverridesStackProps {
  readonly tier: string;
  readonly project?: string;
  readonly region?: string;
}

/**
 * The escape-hatch ladder, one rung per resource. Climb only as far as you must:
 *
 *   0. typed props                         — always first
 *   1. setters / put* / reset* after construction
 *   2. addOverride(path, value)            — any key, rendered JSON, deep-merged
 *   3. overrideLogicalId                   — control the Terraform address
 *   4. raw TerraformResource               — a type the bindings do not have
 *   5. Fn.rawString / call()               — literal `${}` and provider functions
 *   6. TerraformHclModule / remote state   — interop (interop-stack.ts)
 */
export class OverridesStack extends TerraformStack {
  readonly api: CloudRunV2Service;
  readonly db: SqlDatabaseInstance;
  readonly newThing: TerraformResource;

  constructor(scope: Construct, id: string, props: OverridesStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    const region = props.region ?? gcpRegion();
    new GoogleProvider(this, 'Google', { project: props.project ?? gcpProject(), region });
    const name = (component: string) => resourceName({ org: 'cdkm', service: 'hatch', env: tier.name, component });

    const runtime = new ServiceAccount(this, 'Runtime', { accountId: name('rt').slice(0, 30) });

    // -- Rung 2: addOverride on a nested key and on a list index -------------
    this.api = new CloudRunV2Service(this, 'Api', {
      name: name('api'),
      location: region,
      template: {
        serviceAccount: runtime.email,
        containers: [
          {
            image: 'us-docker.pkg.dev/cloudrun/container/hello',
            // Rung 5: `${PORT}` is Cloud Run's *runtime* variable, not a
            // Terraform interpolation. Fn.rawString renders `$${PORT}` so
            // Terraform passes the literal through.
            env: [{ name: 'LISTEN', value: Fn.rawString('0.0.0.0:${PORT}') }],
          },
        ],
      },
    });
    // A single nested block (`template`) renders as a JSON object: path has NO index.
    // A list block (`containers`) renders as a JSON array: path uses the index.
    this.api.addOverride('template.containers.0.image', 'us-docker.pkg.dev/cloudrun/container/hello:latest');
    // A key the bindings expose but we want to set generically (see module 06
    // for why an aspect might): nested key with dots.
    this.api.addOverride('template.scaling.min_instance_count', tier.highlyAvailable ? 1 : 0);
    // A meta-argument: lifecycle.ignore_changes (list -> appended if present).
    this.api.addOverride('lifecycle.ignore_changes', ['client', 'client_version']);

    // -- Rung 3: overrideLogicalId -------------------------------------------
    this.db = new SqlDatabaseInstance(this, 'OrdersDb', {
      name: name('db'),
      databaseVersion: 'POSTGRES_16',
      region,
      settings: { tier: 'db-f1-micro' },
      deletionProtection: tier.retainStatefulResources,
    });
    // The HCL this replaced called it `main`; keep the address so state matches.
    this.db.overrideLogicalId('main');
    // `settings` is a single block -> object -> no `.0.`
    this.db.addOverride('settings.deletion_protection_enabled', tier.retainStatefulResources);

    // -- Rung 4: a resource type the prebuilt provider does not know ----------
    // Pretend the provider shipped `google_some_new_thing` yesterday. The raw
    // class gives you the meta-arguments (provider, depends_on, lifecycle,
    // count/for_each) and nothing else: every attribute is an override, and
    // reading outputs is `getStringAttribute`. `terraformGeneratorMetadata`
    // tells cdktf which required_providers entry this belongs to.
    this.newThing = new TerraformResource(this, 'NewThing', {
      terraformResourceType: 'google_some_new_thing',
      terraformGeneratorMetadata: { providerName: 'google', providerVersionConstraint: '~> 6.0' },
      dependsOn: [this.db],
    });
    this.newThing.addOverride('name', name('thing'));
    this.newThing.addOverride('instance', this.db.name);
    this.newThing.addOverride('settings', { mode: 'FAST', replicas: 2 });

    // -- Rung 5: provider-defined functions (Terraform >= 1.8) ----------------
    // The Google provider ships `provider::google::project_from_id`,
    // `name_from_id`, `region_from_id`, `zone_from_id`, `location_from_id`,
    // `region_from_zone`, `apphub_service_id`. They are namespaced functions
    // the provider evaluates during plan; cdktf has no typed wrapper, so `call`
    // renders the invocation verbatim.
    new TerraformOutput(this, 'DbProject', { value: call('provider::google::project_from_id', [this.db.id]) });
    new TerraformOutput(this, 'ThingId', { value: this.newThing.getStringAttribute('id') });

    // A bucket with an attribute newer than the bindings could be set the same way.
    const logs = new StorageBucket(this, 'Logs', { name: name('logs'), location: region.toUpperCase(), uniformBucketLevelAccess: true });
    logs.addOverride('soft_delete_policy.retention_duration_seconds', tier.retainStatefulResources ? 604800 : 0);
  }
}
