import { Annotations, IAspect } from 'cdktf';
import { IConstruct } from 'constructs';
import { isLabelledResource } from '../labels-aspect';

/**
 * Exercise 1 (easy): a validating aspect that requires a set of label keys on
 * every resource that accepts labels.
 *
 * Pairs with `LabelsAspect`: add the mutator first and this validator second,
 * and the validator proves the mutator did its job for *every* resource type,
 * including ones nobody thought about (a `google_compute_global_address`
 * accepts labels; did you know?).
 */
export class RequireLabelKeysAspect implements IAspect {
  constructor(private readonly requiredKeys: string[]) {}

  visit(node: IConstruct): void {
    if (!isLabelledResource(node)) return;
    const present = new Set(Object.keys(node.labelsInput ?? {}));
    const missing = this.requiredKeys.filter((k) => !present.has(k));
    if (missing.length > 0) {
      Annotations.of(node).addError(`${node.terraformResourceType} is missing required labels: ${missing.join(', ')}`);
    }
  }
}
