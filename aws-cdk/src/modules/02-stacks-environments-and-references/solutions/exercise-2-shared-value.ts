import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Exercise 2 — a typed publish/consume pair over SSM.
 *
 * The naming contract lives in one place, publishers cannot misspell it, and consumers
 * choose deploy-time (`AWS::SSM::Parameter::Value<String>`) or synth-time (lookup)
 * resolution explicitly. Lists are stored as comma-joined strings because the consumer
 * side of `StringListParameter` is awkward to reference by name.
 */
export interface SharedValueNameParts {
  readonly org: string;
  readonly env: string;
  readonly producer: string;
  readonly key: string;
}

export function sharedValueName(p: SharedValueNameParts): string {
  return `/${p.org}/${p.env}/${p.producer}/${p.key}`;
}

export class SharedValue {
  /** Publisher side. Returns the parameter so the caller can grant read on it if needed. */
  static publish(scope: Construct, id: string, parts: SharedValueNameParts, value: string): ssm.StringParameter {
    return new ssm.StringParameter(scope, id, {
      parameterName: sharedValueName(parts),
      stringValue: value,
      description: `Published by ${parts.producer} for ${parts.env}`,
    });
  }

  /** Consumer side, resolved by CloudFormation at deploy time. Safe in env-agnostic stacks. */
  static consumeAtDeploy(scope: Construct, parts: SharedValueNameParts): string {
    return ssm.StringParameter.valueForStringParameter(scope, sharedValueName(parts));
  }

  /**
   * Consumer side, resolved at synth time through the context cache. Requires a concrete
   * env; returns `dummy-value-for-<name>` (and a `manifest.missing` entry) until cached.
   */
  static consumeAtSynth(scope: Construct, parts: SharedValueNameParts): string {
    const stack = cdk.Stack.of(scope);
    if (cdk.Token.isUnresolved(stack.account) || cdk.Token.isUnresolved(stack.region)) {
      throw new Error(`SharedValue.consumeAtSynth requires a concrete env on stack "${stack.node.path}"`);
    }
    return ssm.StringParameter.valueFromLookup(scope, sharedValueName(parts));
  }
}
