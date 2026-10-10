import { Annotations, IAspect, TerraformResource } from 'cdktf';
import { IConstruct } from 'constructs';
import { PubsubTopic } from '@cdktf/provider-google/lib/pubsub-topic';

/**
 * Two deliberately tiny aspects so the test file can show *how to test aspects*
 * without the reader having to understand module 06 first.
 */

/** Mutating: every Pub/Sub topic keeps messages at least `minimum` (a "7d in prod" rule). */
export class MinimumRetentionAspect implements IAspect {
  constructor(private readonly minimumSeconds: number) {}

  visit(node: IConstruct): void {
    if (!(node instanceof PubsubTopic)) return;
    const current = parseInt((node.messageRetentionDurationInput ?? '0s').replace(/s$/, ''), 10);
    if (Number.isNaN(current) || current < this.minimumSeconds) {
      node.messageRetentionDuration = `${this.minimumSeconds}s`;
    }
  }
}

/** Validating: no resource may carry a `description` containing "TODO". */
export class NoTodoDescriptionsAspect implements IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof TerraformResource)) return;
    if (!('descriptionInput' in node)) return;
    const description = (node as unknown as { descriptionInput?: string }).descriptionInput;
    if (typeof description === 'string' && /\bTODO\b/.test(description)) {
      Annotations.of(node).addError(`${node.terraformResourceType} description contains TODO: "${description}"`);
    }
  }
}
