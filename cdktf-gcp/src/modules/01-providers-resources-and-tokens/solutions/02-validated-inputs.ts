/**
 * Exercise 2 — validation at every layer.
 *
 * Three places a bad value can be caught, in order of preference:
 *   1. TypeScript, at construct time (props): fastest feedback, fully testable.
 *   2. `variable.validation`, at plan time: for operator-supplied values.
 *   3. `lifecycle.precondition` / `postcondition`, at plan/apply time: for values
 *      that depend on other resources or data sources.
 *
 * Build a stack that uses all three for the same rule — "buckets may only live
 * in an allowed list of locations" — and make the location list a variable so
 * the rule survives being driven from a .tfvars file.
 */
import { Fn, Op, TerraformOutput, TerraformStack, TerraformVariable, VariableType, ref } from 'cdktf';
import { Construct } from 'constructs';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { environmentFor, resourceName } from '@cdk-mastery/shared';
import { configureProviders } from '../providers';
import { ProjectFacts } from '../project-facts';

export interface ValidatedBucketStackProps {
  readonly tier: string;
  /** Requested bucket location; validated in TypeScript against `allowedLocations`. */
  readonly location: string;
  readonly allowedLocations: string[];
  readonly project?: string;
}

export class ValidatedBucketStack extends TerraformStack {
  readonly bucket: StorageBucket;

  constructor(scope: Construct, id: string, props: ValidatedBucketStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);

    // Layer 1: TypeScript.
    if (!props.allowedLocations.includes(props.location)) {
      throw new Error(`location "${props.location}" is not in allowedLocations [${props.allowedLocations.join(', ')}]`);
    }

    configureProviders(this, { project: props.project });
    const facts = new ProjectFacts(this, 'Facts', { region: 'us-central1' });

    // Layer 2: a variable the operator may override at plan time, with a
    // validation that keeps it a subset of what TypeScript allowed.
    const allowed = new TerraformVariable(this, 'allowed_locations', {
      type: VariableType.LIST_STRING,
      default: props.allowedLocations,
      description: 'Locations buckets may be created in. Must be a subset of the compiled-in list.',
    });
    // cdktf 0.21 quirk: `Op.*` renders a *falsy* right operand (0, false, "") as
    // `undefined` (tfExpression.js: `this.right ? ... : undefined`). Put the
    // literal on the left, or compare with `< 1` instead of `== 0`.
    allowed.addValidation({
      condition: Op.eq(0, Fn.lengthOf(Fn.setsubtract(allowed.listValue, props.allowedLocations))),
      errorMessage: `allowed_locations may only contain: ${props.allowedLocations.join(', ')}`,
    });
    allowed.addValidation({
      condition: Op.gte(Fn.lengthOf(allowed.listValue), 1),
      errorMessage: 'allowed_locations must not be empty.',
    });

    // Layer 3: conditions on the resource itself.
    this.bucket = new StorageBucket(this, 'Bucket', {
      name: resourceName({ org: 'cdkm', service: 'tokens', env: tier.name, component: 'validated' }),
      location: props.location,
      uniformBucketLevelAccess: true,
      forceDestroy: !tier.retainStatefulResources,
      lifecycle: {
        precondition: [
          {
            condition: Fn.contains(allowed.listValue, props.location),
            errorMessage: `Bucket location ${props.location} is not in var.allowed_locations.`,
          },
        ],
        postcondition: [
          {
            // `self` is the resource after apply. A plain string '${self.x}'
            // would be *escaped* as a literal ("$${self.x}"); `ref()` produces a
            // real reference token for identifiers the typed API cannot reach.
            condition: Op.gte(ref('self.project_number'), 1),
            errorMessage: 'Bucket was created but reports no project number.',
          },
        ],
      },
    });

    new TerraformOutput(this, 'project_number', { value: facts.projectNumber });
  }
}
