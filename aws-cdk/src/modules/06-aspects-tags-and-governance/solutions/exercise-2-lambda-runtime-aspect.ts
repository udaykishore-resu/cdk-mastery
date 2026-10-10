import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { IConstruct } from 'constructs';

/**
 * Exercise 2 — mutating aspect that migrates deprecated Node.js runtimes.
 *
 * Lambda deprecates a Node major roughly every 12 months; after the deprecation
 * date `UpdateFunctionConfiguration` is rejected, which means *any* CDK change
 * to the function fails to deploy. A fleet-wide aspect is the cheapest fix and,
 * because it is MUTATING, it runs before cdk-nag's `AwsSolutions-L1` check.
 *
 * Two subtleties this solution gets right:
 *  1. `runtime` on the L1 may be a token (rare, but `Fn.conditionIf` exists).
 *     `Token.isUnresolved` guards the string comparison.
 *  2. A function that opted into `NODEJS_LATEST` already renders the newest
 *     runtime the library knows; the map only lists *deprecated* names, so
 *     anything else is left untouched.
 */
export const RUNTIME_UPGRADES: Record<string, string> = {
  'nodejs14.x': lambda.Runtime.NODEJS_22_X.name,
  'nodejs16.x': lambda.Runtime.NODEJS_22_X.name,
  'nodejs18.x': lambda.Runtime.NODEJS_22_X.name,
};

export class LambdaRuntimeAspect implements cdk.IAspect {
  constructor(private readonly upgrades: Record<string, string> = RUNTIME_UPGRADES) {}

  visit(node: IConstruct): void {
    if (!(node instanceof lambda.CfnFunction)) return;
    const current = node.runtime;
    if (current === undefined || cdk.Token.isUnresolved(current)) return;
    const target = this.upgrades[current];
    if (!target) return;
    node.runtime = target;
    cdk.Annotations.of(node).addInfo(`LambdaRuntimeAspect: upgraded runtime ${current} -> ${target}`);
  }
}
