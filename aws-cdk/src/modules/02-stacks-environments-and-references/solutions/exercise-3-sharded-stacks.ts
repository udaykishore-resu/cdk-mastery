import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/**
 * Exercise 3 — split by cardinality without ever renumbering.
 *
 * `createShardedQueues` distributes N tenant queues over stacks of at most `perStack`
 * queues. Two properties matter more than the arithmetic:
 *   1. A tenant's stack is a pure function of its position in a *stable, ordered* list.
 *      Appending tenants only ever creates new shards; deleting one leaves a hole rather
 *      than shifting everyone (which would replace every queue after it). The `tenants`
 *      array must therefore be treated as append-only in source control.
 *   2. Stack ids embed the shard index (`Shard0`, `Shard1`), never the tenant names, so
 *      renaming a tenant does not rename a stack.
 *
 * Each shard stack gets the module's `ResourceBudget` aspect so it fails synth if a
 * future L2 change makes a shard exceed the limit.
 */
export interface ShardedQueuesProps {
  readonly idPrefix: string;
  /** Append-only list of tenant identifiers. `undefined` marks a removed tenant (hole). */
  readonly tenants: ReadonlyArray<string | undefined>;
  readonly perStack: number;
  readonly env?: cdk.Environment;
}

export interface ShardPlacement {
  readonly tenant: string;
  readonly stackId: string;
  readonly queue: sqs.Queue;
}

class ShardStack extends cdk.Stack {
  readonly queues: Record<string, sqs.Queue> = {};
  constructor(scope: Construct, id: string, props: cdk.StackProps & { tenants: ReadonlyArray<[number, string]> }) {
    super(scope, id, props);
    for (const [index, tenant] of props.tenants) {
      // The construct id is positional too; the tenant name only appears in the physical name.
      this.queues[tenant] = new sqs.Queue(this, `Tenant${index}`, {
        queueName: `${cdk.Stack.of(this).stackName}-${tenant}`.toLowerCase(),
        enforceSSL: true,
      });
    }
  }
}

export function createShardedQueues(scope: Construct, props: ShardedQueuesProps): ShardPlacement[] {
  if (props.perStack < 1) throw new Error('perStack must be >= 1');
  const placements: ShardPlacement[] = [];
  const shardCount = Math.ceil(props.tenants.length / props.perStack);
  for (let shard = 0; shard < shardCount; shard++) {
    const members: [number, string][] = [];
    for (let i = shard * props.perStack; i < Math.min((shard + 1) * props.perStack, props.tenants.length); i++) {
      const tenant = props.tenants[i];
      if (tenant !== undefined) members.push([i, tenant]);
    }
    if (members.length === 0) continue; // an all-holes shard: do not create an empty stack
    const stackId = `${props.idPrefix}Shard${shard}`;
    const stack = new ShardStack(scope, stackId, { env: props.env, tenants: members });
    for (const [, tenant] of members) placements.push({ tenant, stackId, queue: stack.queues[tenant] });
  }
  return placements;
}
