import {
  Fn,
  Op,
  TerraformIterator,
  TerraformLocal,
  TerraformOutput,
  TerraformStack,
  TerraformVariable,
  VariableType,
  propertyAccess,
} from 'cdktf';
import { Construct } from 'constructs';
import { ProjectService } from '@cdktf/provider-google/lib/project-service';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { GooglePubsubTopic } from '@cdktf/provider-google-beta/lib/google-pubsub-topic';
import { RandomProvider } from '@cdktf/provider-random/lib/provider';
import { Id } from '@cdktf/provider-random/lib/id';
import { environmentFor, mandatoryTags } from '@cdk-mastery/shared';
import { configureProviders } from './providers';
import { ProjectFacts } from './project-facts';
import { gcpRegion } from './gcp-config';

/** One entry per bucket to create; the map key becomes the `for_each` key and part of the name. */
export interface BucketSpec {
  readonly storageClass: 'STANDARD' | 'NEARLINE' | 'COLDLINE' | 'ARCHIVE';
  /** Days before objects are deleted; must be >= 1 (validated in TypeScript, not by Terraform). */
  readonly retentionDays: number;
  readonly purpose: string;
}

export interface TokensStackProps {
  readonly tier: string;
  readonly buckets: Record<string, BucketSpec>;
  readonly project?: string;
  readonly region?: string;
  readonly impersonateServiceAccount?: string;
}

export const DEFAULT_BUCKETS: Record<string, BucketSpec> = {
  raw: { storageClass: 'STANDARD', retentionDays: 30, purpose: 'ingest' },
  curated: { storageClass: 'NEARLINE', retentionDays: 180, purpose: 'analytics' },
  archive: { storageClass: 'ARCHIVE', retentionDays: 3650, purpose: 'compliance' },
};

/**
 * Everything Terraform-the-language can express, driven from TypeScript:
 * variables, locals, data sources, `for_each`, `count`, `dynamic` blocks,
 * conditionals, meta-arguments, and the escape hatch. Read top to bottom.
 */
export class TokensStack extends TerraformStack {
  readonly bucketsByKey: StorageBucket;
  readonly auditBucket: StorageBucket;
  readonly facts: ProjectFacts;

  constructor(scope: Construct, id: string, props: TokensStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    const region = props.region ?? gcpRegion();
    // Validate in TypeScript what TypeScript knows. Terraform `validation` blocks
    // (below) are for values that only exist at plan time.
    for (const [key, spec] of Object.entries(props.buckets)) {
      if (!Number.isInteger(spec.retentionDays) || spec.retentionDays < 1) {
        throw new Error(`buckets.${key}.retentionDays must be a positive integer, got ${spec.retentionDays}`);
      }
    }

    // ---- Providers -------------------------------------------------------
    const { beta } = configureProviders(this, {
      project: props.project,
      region,
      impersonateServiceAccount: props.impersonateServiceAccount,
      defaultLabels: mandatoryTags(tier, 'tokens'),
    });
    new RandomProvider(this, 'Random');

    // ---- Data sources ----------------------------------------------------
    this.facts = new ProjectFacts(this, 'Facts', { region });

    // ---- Variables -------------------------------------------------------
    // Variables are for values the *operator* sets at plan time (-var, TF_VAR_x,
    // a .tfvars file). If TypeScript already knows the value, use a prop, not a
    // variable: variables are invisible to the type checker and to tests.
    const bucketPrefix = new TerraformVariable(this, 'bucket_prefix', {
      type: VariableType.STRING,
      default: 'cdkm',
      description: 'Global name prefix; must be a DNS label because bucket names are.',
    });
    // Validation references the variable itself, so it is added after construction.
    bucketPrefix.addValidation({
      condition: Fn.can(Fn.regex('^[a-z][a-z0-9-]{1,20}$', bucketPrefix.stringValue)),
      errorMessage: 'bucket_prefix must be 2-21 chars of [a-z0-9-] starting with a letter.',
    });
    const enableAudit = new TerraformVariable(this, 'enable_audit_bucket', {
      type: VariableType.BOOL,
      default: false,
      description: 'Create the audit-log sink bucket (conditional resource demo).',
    });
    const auditRetentionDays = new TerraformVariable(this, 'audit_retention_days', {
      type: VariableType.NUMBER,
      default: 400,
    });
    auditRetentionDays.addValidation({
      condition: Op.gte(auditRetentionDays.numberValue, 1),
      errorMessage: 'audit_retention_days must be >= 1.',
    });
    const auditPrincipal = new TerraformVariable(this, 'audit_reader', {
      type: VariableType.STRING,
      default: '',
      sensitive: true,
      description: 'Optional principal (user:/group:/serviceAccount:) that may read audit logs.',
    });
    // Object-typed variable: a list of lifecycle transitions, iterated by a dynamic block below.
    const transitions = new TerraformVariable(this, 'archive_transitions', {
      type: VariableType.list(VariableType.object({ age: VariableType.NUMBER, storage_class: VariableType.STRING })),
      default: [
        { age: 30, storage_class: 'NEARLINE' },
        { age: 90, storage_class: 'COLDLINE' },
      ],
    });

    // ---- Locals ----------------------------------------------------------
    // A local is an expression Terraform evaluates. Use one when the same
    // expression appears in several places *in the JSON*; for TypeScript-only
    // reuse a `const` is better because it needs no Terraform evaluation.
    const namePrefix = new TerraformLocal(this, 'name_prefix', Fn.format('%s-%s', [bucketPrefix.stringValue, tier.name]));
    const commonLabels = new TerraformLocal(this, 'common_labels', mandatoryTags(tier, 'tokens'));
    const bucketSpecs = new TerraformLocal(this, 'bucket_specs', props.buckets);

    // ---- Explicit dependency ---------------------------------------------
    // Nothing references the API enablement, so Terraform cannot infer that the
    // buckets need it. `dependsOn` is for exactly this: ordering without a data edge.
    const storageApi = new ProjectService(this, 'StorageApi', {
      service: 'storage.googleapis.com',
      disableOnDestroy: false,
    });

    // ---- for_each over a map ---------------------------------------------
    // One `resource` block, N instances keyed by map key. `iterator.key` and
    // `iterator.getString('field')` render `each.key` / `each.value.field`.
    const bucketIterator = TerraformIterator.fromMap(props.buckets);
    this.bucketsByKey = new StorageBucket(this, 'Buckets', {
      forEach: bucketIterator,
      dependsOn: [storageApi],
      name: Fn.format('%s-%s', [namePrefix.asString, bucketIterator.key]),
      location: region,
      storageClass: bucketIterator.getString('storageClass'),
      uniformBucketLevelAccess: true,
      publicAccessPrevention: 'enforced',
      forceDestroy: !tier.retainStatefulResources,
      // Per-entry labels: static ones from the tier merged with the entry's purpose.
      labels: Fn.merge([commonLabels.asStringMap, { purpose: bucketIterator.getString('purpose'), key: bucketIterator.key }]),
      lifecycleRule: [{ action: { type: 'Delete' }, condition: { age: bucketIterator.getNumber('retentionDays') } }],
    });

    // ---- Conditional resource: count on a ternary --------------------------
    // `count = var.enable_audit_bucket ? 1 : 0`. The resource address becomes a
    // list (`google_storage_bucket.Audit[0]`), which is why reading attributes
    // from it below goes through `one(...)`.
    this.auditBucket = new StorageBucket(this, 'Audit', {
      count: Fn.conditional(enableAudit.value, 1, 0),
      dependsOn: [storageApi],
      name: Fn.format('%s-audit', [namePrefix.asString]),
      location: region,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: 'enforced',
      retentionPolicy: { retentionPeriod: Op.mul(auditRetentionDays.numberValue, 86400), isLocked: tier.retainStatefulResources },
      lifecycle: {
        preventDestroy: tier.retainStatefulResources,
        // Someone's labelling bot may touch labels; do not fight it in every plan.
        ignoreChanges: ['labels'],
        precondition: [
          {
            condition: Op.or(Op.not(enableAudit.value), Op.gte(auditRetentionDays.numberValue, 365)),
            errorMessage: 'Audit buckets must retain objects for at least 365 days.',
          },
        ],
      },
    });

    // ---- dynamic block from a list variable -------------------------------
    // `dynamic "lifecycle_rule" { for_each = var.archive_transitions ... }`. The
    // iterator is a *different* one from the map iterator above, because it
    // walks a different collection.
    const transitionIterator = TerraformIterator.fromList(transitions.listValue);
    const suffix = new Id(this, 'Suffix', {
      byteLength: 2,
      // Keepers: change any of these and the id (and therefore the bucket) is
      // replaced. create_before_destroy makes the new id exist before the old is
      // dropped so downstream references never see a gap.
      keepers: { tier: tier.name, prefix: bucketPrefix.stringValue },
      lifecycle: { createBeforeDestroy: true },
    });
    const tiered = new StorageBucket(this, 'Tiered', {
      dependsOn: [storageApi],
      name: `${namePrefix.asString}-tiered-${suffix.hex}`,
      location: region,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: 'enforced',
      forceDestroy: !tier.retainStatefulResources,
      lifecycleRule: transitionIterator.dynamic({
        action: { type: 'SetStorageClass', storageClass: transitionIterator.getString('storage_class') },
        condition: { age: transitionIterator.getNumber('age') },
      }),
    });

    // ---- A beta-only resource via the aliased provider --------------------
    const events = new GooglePubsubTopic(this, 'Events', {
      provider: beta,
      name: `${namePrefix.asString}-events`,
      messageRetentionDuration: '86400s',
    });

    // ---- The escape hatch -------------------------------------------------
    // `addOverride` writes any path into the element's JSON, bypassing the typed
    // bindings. Use it for attributes the provider added after the bindings were
    // generated, or for syntax the bindings cannot express. Here: ignore changes
    // to a *single map key* — the typed `ignoreChanges` takes attribute names,
    // but Terraform also accepts index expressions like `labels["k"]`.
    events.addOverride('lifecycle.ignore_changes', ['labels["last-published"]']);

    // ---- Outputs: what tokens look like -------------------------------------
    // Attribute tokens of the same resource are *different* strings:
    //   name     -> "cdkm-dev-tiered-ab12"                        (what you set)
    //   id       -> "cdkm-dev-tiered-ab12"  for buckets (provider chooses id == name)
    //   selfLink -> "https://www.googleapis.com/storage/v1/b/cdkm-dev-tiered-ab12"
    //   url      -> "gs://cdkm-dev-tiered-ab12"
    // Which one an IAM member or another resource wants is in that resource's docs.
    new TerraformOutput(this, 'tiered_name', { value: tiered.name });
    new TerraformOutput(this, 'tiered_id', { value: tiered.id });
    new TerraformOutput(this, 'tiered_self_link', { value: tiered.selfLink });
    // Template literals with tokens are fine: the token is a string with markers.
    new TerraformOutput(this, 'tiered_export_uri', { value: `gs://${tiered.name}/exports/${tier.name}` });

    // for_each resources are maps of objects; splat needs `values(...)` first.
    new TerraformOutput(this, 'bucket_names', {
      value: propertyAccess(Fn.values(this.bucketsByKey.fqn), ['*', 'name']),
    });
    // `lookup` with a default: safe access into a map that may lack the key.
    new TerraformOutput(this, 'raw_bucket_class', {
      value: Fn.lookup(Fn.lookup(bucketSpecs.asAnyMap, 'raw', {}), 'storageClass', 'STANDARD'),
    });
    // `one()` turns a 0-or-1 element list into a value-or-null.
    new TerraformOutput(this, 'audit_bucket_name', {
      value: Fn.one(propertyAccess(this.auditBucket.fqn, ['*', 'name'])),
    });
    new TerraformOutput(this, 'audit_reader_principal', { value: auditPrincipal.stringValue, sensitive: true });

    new TerraformOutput(this, 'project_number', { value: this.facts.projectNumber });
    new TerraformOutput(this, 'first_zone', { value: this.facts.firstZone });
    new TerraformOutput(this, 'zone_count', { value: this.facts.zoneCount });
    new TerraformOutput(this, 'provider_project', { value: this.facts.client.project });

    // Networking math and JSON without templatefile: `cidrsubnet` and `jsonencode`
    // are Terraform functions; the object literal is plain TypeScript.
    new TerraformOutput(this, 'first_subnet_cidr', { value: Fn.cidrsubnet('10.10.0.0/16', 8, 1) });
    new TerraformOutput(this, 'bucket_policy_json', {
      value: Fn.jsonencode({
        version: 1,
        buckets: propertyAccess(Fn.values(this.bucketsByKey.fqn), ['*', 'name']),
        events: events.id,
      }),
    });
  }
}
