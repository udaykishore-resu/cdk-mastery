import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagMessageLevel, NagPack, NagPackProps, NagRuleCompliance, NagRuleResult } from 'cdk-nag';
import { IConstruct } from 'constructs';

/**
 * Exercise 3 — a custom cdk-nag pack.
 *
 * The AwsSolutions pack encodes AWS's opinions. Your organisation has its own:
 * "every SQS queue has a dead-letter queue" is one that AwsSolutions-SQS3 also
 * checks, but ours goes further and requires `maxReceiveCount >= 3` (a DLQ with
 * `maxReceiveCount: 1` turns every transient error into an incident).
 *
 * A pack is a class with `checkResource(node: CfnResource)` that calls
 * `applyRule` for each rule. The rule id is `${packName}-${rule.name}`, so the
 * rule *function name* becomes part of the public contract people acknowledge
 * against (`Validations.of(x).acknowledge({ id: 'HouseRules-SqsRedrivePolicy' })`).
 * Do not use arrow functions for rules: their `.name` is empty.
 *
 * Because it is a plugin, it registers and reports exactly like AwsSolutions:
 *   Validations.of(app).addPlugins(new HouseRulesPack(app, { verbose: true }))
 */
export class HouseRulesPack extends NagPack {
  readonly name = 'HouseRules';

  constructor(scope?: IConstruct, props?: NagPackProps) {
    super(scope, props);
    this.packName = 'HouseRules';
  }

  protected checkResource(node: cdk.CfnResource): void {
    if (node.cfnResourceType !== 'AWS::SQS::Queue') return;
    this.applyRule({
      info: 'The SQS queue has no redrive policy, or its maxReceiveCount is below 3.',
      explanation:
        'Without a DLQ, poison messages are retried until they expire and block consumers; ' +
        'a maxReceiveCount below 3 sends transient failures straight to the DLQ.',
      level: NagMessageLevel.ERROR,
      node,
      rule: SqsRedrivePolicy,
    });
  }
}

/** Named function on purpose: `rule.name` becomes the rule id suffix. */
export function SqsRedrivePolicy(node: cdk.CfnResource): NagRuleResult {
  const queue = node as sqs.CfnQueue;
  const redrive = cdk.Stack.of(node).resolve(queue.redrivePolicy) as { maxReceiveCount?: unknown } | undefined;
  if (!redrive) return NagRuleCompliance.NON_COMPLIANT;
  const count = redrive.maxReceiveCount;
  if (typeof count === 'number' && count >= 3) return NagRuleCompliance.COMPLIANT;
  // A token (e.g. a CfnParameter) cannot be judged at synth time — treat as compliant
  // rather than blocking; the deploy-time guard belongs in a CFN hook / SCP.
  if (typeof count !== 'number') return NagRuleCompliance.COMPLIANT;
  return NagRuleCompliance.NON_COMPLIANT;
}
