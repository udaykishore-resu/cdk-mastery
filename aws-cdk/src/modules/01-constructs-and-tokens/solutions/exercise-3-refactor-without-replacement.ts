import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/**
 * Exercise 3 — refactor the tree without replacing stateful resources.
 *
 * Before: the table and queue sat directly under the stack:
 *     Stack/Orders/Resource   -> Orders<hashA>
 *     Stack/Events/Resource   -> Events<hashB>
 * After: they live in a `Storage` construct, which changes both paths (and both IDs).
 * CloudFormation would delete the old table and create a new, empty one.
 *
 * Two mechanisms keep the deployed IDs:
 *   - `stack.renameLogicalId(oldId, newId)`: a stack-wide rename map, applied in
 *     `getLogicalId()`. Best when you have a list of (new -> old) pairs from the previous
 *     template, e.g. produced by a script that diffs `cdk.out` before and after.
 *   - `cfn.overrideLogicalId(oldId)`: per element, bypasses the stack entirely. Best for a
 *     one-off pin next to the construct so future readers see why.
 * `cdk refactor` (CLI 2.1100+) can generate the mapping and apply it via CloudFormation's
 * stack refactoring API instead; the code-level pins above are what you use when the
 * account does not allow that or the resources are already in flight.
 */
export interface RefactoredStackProps extends cdk.StackProps {
  /** Logical IDs from the *deployed* template, keyed by the construct id inside Storage. */
  readonly deployedIds: { readonly orders: string; readonly events: string };
}

export class Storage extends Construct {
  readonly orders: dynamodb.TableV2;
  readonly events: sqs.Queue;
  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.orders = new dynamodb.TableV2(this, 'Orders', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.events = new sqs.Queue(this, 'Events', { enforceSSL: true });
  }
}

export class RefactoredStack extends cdk.Stack {
  readonly storage: Storage;
  constructor(scope: Construct, id: string, props: RefactoredStackProps) {
    super(scope, id, props);
    this.storage = new Storage(this, 'Storage');

    // Mechanism 1: stack-level rename map. The current (allocated) ID is the key.
    const ordersCfn = this.storage.orders.node.defaultChild as cdk.CfnResource;
    this.renameLogicalId(this.getLogicalId(ordersCfn), props.deployedIds.orders);

    // Mechanism 2: per-element pin.
    (this.storage.events.node.defaultChild as cdk.CfnResource).overrideLogicalId(props.deployedIds.events);
  }
}
