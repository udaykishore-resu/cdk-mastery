import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/**
 * Exercise 1 — the invisible `Default` scope.
 *
 * `makeUniqueId` drops every path component named `Default` before hashing. That lets a
 * construct introduce an *organisational* scope (to group children, to hang an aspect on,
 * to keep ids unique) without changing anyone's logical IDs. Compare:
 *
 *   Stack/Queues/Jobs/Resource       -> QueuesJobs<hash>
 *   Stack/Default/Jobs/Resource      -> Jobs<hash>   (identical to Stack/Jobs/Resource)
 *
 * The framework uses this itself: `NestedStack` and several L2s create a child called
 * `Default` so their wrapper does not leak into IDs. Use it when you introduce a grouping
 * construct into an already-deployed stack and must not replace resources.
 */
export class GroupedQueues extends Construct {
  readonly jobs: sqs.Queue;
  constructor(scope: Construct, id: string) {
    super(scope, id);
    // Everything under `Default` gets the same logical IDs as if it lived directly under
    // the parent of `GroupedQueues` — provided `GroupedQueues` itself is named `Default`.
    this.jobs = new sqs.Queue(this, 'Jobs', { enforceSSL: true });
  }
}

export class DefaultScopeStack extends cdk.Stack {
  readonly grouped: GroupedQueues;
  readonly direct: sqs.Queue;
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    this.grouped = new GroupedQueues(this, 'Default');
    // Would collide with the queue above if both rendered to `Jobs<hash>` — so this one has
    // a different id. The test shows the collision error you get otherwise.
    this.direct = new sqs.Queue(this, 'Other', { enforceSSL: true });
  }
}
