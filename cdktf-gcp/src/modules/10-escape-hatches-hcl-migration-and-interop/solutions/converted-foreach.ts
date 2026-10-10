import { TerraformIterator, TerraformOutput, TerraformStack, TerraformVariable } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { PubsubTopic } from '@cdktf/provider-google/lib/pubsub-topic';
import { PubsubSubscription } from '@cdktf/provider-google/lib/pubsub-subscription';

/**
 * Exercise 2 (medium): converting HCL that uses `for_each`.
 *
 *   variable "topics" {
 *     type = map(object({ retention = string }))
 *     default = { orders = { retention = "86400s" }, refunds = { retention = "604800s" } }
 *   }
 *   resource "google_pubsub_topic" "t" {
 *     for_each                   = var.topics
 *     name                       = each.key
 *     message_retention_duration = each.value.retention
 *   }
 *   resource "google_pubsub_subscription" "s" {
 *     for_each = google_pubsub_topic.t
 *     name     = "${each.key}-sub"
 *     topic    = each.value.name
 *   }
 *   output "topic_ids" { value = { for k, t in google_pubsub_topic.t : k => t.id } }
 *
 * `cdktf convert` turns `for_each` into `TerraformIterator.fromMap(...)` +
 * `forEach:` and `each.key/each.value.x` into `iterator.key` /
 * `iterator.getString('x')` — that part it gets right. What it cannot do is
 * decide whether you *wanted* Terraform-time iteration: if the set of topics is
 * known in TypeScript, a plain loop that creates two constructs gives you
 * separate addresses, per-topic overrides and readable plans. Keep `for_each`
 * only when the collection is a *variable* (decided at plan time), as here.
 *
 * Two things to check after convert, corrected here:
 *   - `for_each = google_pubsub_topic.t` (iterating a *resource*) must become
 *     `TerraformIterator.fromResources(topics)`, not `fromMap`;
 *   - the `{ for k, t in ... : k => t.id }` output is
 *     `iterator.forExpressionForMap('key', 'val.id')` (`pluckProperty` gives a
 *     list, not a map); hand-written `"${{ for ... }}"` strings are what convert
 *     emits and they bypass every check cdktf has.
 */
export class ConvertedForEachStack extends TerraformStack {
  readonly topics: PubsubTopic;
  readonly subscriptions: PubsubSubscription;

  constructor(scope: Construct, id: string, project = 'demo') {
    super(scope, id);
    new GoogleProvider(this, 'Google', { project, region: 'us-central1' });

    const topicsVar = new TerraformVariable(this, 'Topics', {
      type: 'map(object({ retention = string }))',
      default: { orders: { retention: '86400s' }, refunds: { retention: '604800s' } },
    });
    topicsVar.overrideLogicalId('topics');

    const each = TerraformIterator.fromMap(topicsVar.value);
    this.topics = new PubsubTopic(this, 'T', {
      forEach: each,
      name: each.key,
      messageRetentionDuration: each.getString('retention'),
    });
    this.topics.overrideLogicalId('t');

    const eachTopic = TerraformIterator.fromResources(this.topics);
    this.subscriptions = new PubsubSubscription(this, 'S', {
      forEach: eachTopic,
      name: `${eachTopic.key}-sub`,
      topic: eachTopic.getString('name'),
    });
    this.subscriptions.overrideLogicalId('s');

    // pluckProperty('id') would render a *list* `[for key, val in X: val.id]`;
    // the HCL output is a map, so use the explicit map for-expression.
    const out = new TerraformOutput(this, 'TopicIds', { value: eachTopic.forExpressionForMap('key', 'val.id') });
    out.overrideLogicalId('topic_ids');
  }
}
