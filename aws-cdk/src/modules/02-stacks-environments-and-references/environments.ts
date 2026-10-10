import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvironmentTier, regionShortCode } from '@cdk-mastery/shared';

/**
 * Environment-agnostic vs environment-specific stacks.
 *
 * A stack's `env` is `{ account, region }`. Leave it out and the stack is *agnostic*:
 *   - `this.account` / `this.region` are tokens → `{ Ref: "AWS::AccountId" }` / `{ Ref: "AWS::Region" }`
 *   - `this.availabilityZones` is `[Fn::Select(0, Fn::GetAZs), Fn::Select(1, Fn::GetAZs)]` — two, always
 *   - the manifest says `aws://unknown-account/unknown-region`
 *   - the CLI deploys it wherever its credentials point
 *   - context lookups (`Vpc.fromLookup`, `valueFromLookup`, `HostedZone.fromLookup`) are impossible
 *   - anything region-dependent in construct logic (partition-specific ARNs, service
 *     principals, ELB account IDs for access logs, more than 2 AZs) falls back to guesses
 * Pass it and the stack is *specific*: literals everywhere, lookups allowed, and
 * `cdk deploy` refuses to deploy it anywhere else. Note that `availabilityZones` on a
 * specific stack is itself a context lookup (`availability-zones:account=…:region=…`):
 * until the CLI caches it you get `['dummy1a', 'dummy1b', 'dummy1c']` and a
 * `manifest.missing` entry (see lookups.ts).
 *
 * `Aws.REGION` is always the pseudo-parameter token, regardless of the stack's env. Use
 * `Stack.of(this).region` when you want "the literal if known, the token otherwise" —
 * which is what almost every L2 does internally.
 */

export interface EnvStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
}

/** No `env`: deployable anywhere; region only known to CloudFormation. */
export class EnvAgnosticStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EnvStackProps) {
    super(scope, id, props);
    // A physical name that includes the region MUST be built from tokens here.
    new ssm.StringParameter(this, 'Where', {
      parameterName: `/cdk-mastery/${props.tier.name}/agnostic/where`,
      stringValue: `${this.account}/${this.region} (${cdk.Aws.PARTITION})`, // Fn::Join at synth
    });
  }
}

/** With `env`: `this.region` is a plain string you can branch on at synth time. */
export class EnvSpecificStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EnvStackProps & { readonly env: cdk.Environment }) {
    super(scope, id, props);
    // Literal region → we can derive a short code at synth time. Impossible with a token.
    const short = regionShortCode(this.region);
    new ssm.StringParameter(this, 'Where', {
      parameterName: `/cdk-mastery/${props.tier.name}/specific/where`,
      stringValue: `${this.account}/${this.region} (${short}), ${this.availabilityZones.length} AZs known`,
    });
  }
}

export interface EnvironmentDescription {
  readonly agnostic: boolean;
  readonly account: string;
  readonly region: string;
  readonly availabilityZones: string[];
}

/** Explain a stack's environment the way the CLI sees it. */
export function describeEnvironment(stack: cdk.Stack): EnvironmentDescription {
  return {
    agnostic: cdk.Token.isUnresolved(stack.account) || cdk.Token.isUnresolved(stack.region),
    account: cdk.Token.isUnresolved(stack.account) ? 'unknown-account' : stack.account,
    region: cdk.Token.isUnresolved(stack.region) ? 'unknown-region' : stack.region,
    availabilityZones: stack.availabilityZones,
  };
}

/** The convention every module uses to obtain a concrete env from cdk.json context. */
export function envFromContext(app: cdk.App): cdk.Environment {
  return {
    account: app.node.tryGetContext('cdk-mastery:account') ?? '111111111111',
    region: app.node.tryGetContext('cdk-mastery:region') ?? 'us-east-1',
  };
}
