import * as cdk from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

export interface RequireTagsAspectProps {
  /** Tag keys that every taggable resource must carry. */
  readonly requiredKeys: string[];
}

/**
 * READ-ONLY aspect that verifies mandatory tags are present on every taggable L1.
 *
 * This is the aspect that makes *ordering* matter. `Tags.of(scope).add(...)` is
 * itself an aspect: the tag is not on the resource until that aspect has visited
 * it. If RequireTagsAspect runs first it sees an empty TagManager and reports a
 * false positive. Two mechanisms keep it correct:
 *
 *  1. Priority. Apply this aspect with `{ priority: AspectPriority.READONLY }`
 *     (1000). The Tags aspect runs at MUTATING (200) when the feature flag
 *     `@aws-cdk/core:aspectPrioritiesMutating` is on (it is in this repo's
 *     cdk.json), or DEFAULT (500) otherwise. Either way, lower runs first.
 *  2. Inheritance. Aspects applied on an ancestor run on a node *before* aspects
 *     applied on the node itself when priorities tie — so Tags on the App and a
 *     validator on the Stack also order correctly.
 *
 * It reads `TagManager.tagValues()`, which is the *effective* tag set after
 * priority resolution and `includeResourceTypes` filtering — the same data that
 * `renderTags()` writes into the template.
 */
export class RequireTagsAspect implements cdk.IAspect {
  constructor(private readonly props: RequireTagsAspectProps) {}

  visit(node: IConstruct): void {
    if (!cdk.CfnResource.isCfnResource(node)) return;
    const tags = cdk.TagManager.of(node);
    if (!tags) return; // resource type has no Tags property; nothing to require

    const present = tags.tagValues();
    const missing = this.props.requiredKeys.filter((k) => !(k in present));
    if (missing.length === 0) return;

    cdk.Annotations.of(node).addError(
      `RequireTagsAspect: ${node.cfnResourceType} is missing required tag(s): ${missing.join(', ')}`,
    );
  }
}
