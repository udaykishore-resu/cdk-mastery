import * as crypto from 'node:crypto';
import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Re-implementation of `makeUniqueId` from `aws-cdk-lib/core/lib/private/uniqueid.js`,
 * so you can predict a logical ID from a construct path without a synth.
 *
 * Input: the path components *below the stack* (the stack id itself is NOT included;
 * `Stack.allocateLogicalId` slices `node.scopes` after the stack).
 *
 * Rules, in order:
 *   1. Components named `Default` are dropped entirely (they are invisible).
 *   2. If exactly one component remains, the ID is that component with non-alphanumerics
 *      removed — and NO hash. That is why `new CfnOutput(stack, 'BucketName')` is just
 *      `BucketName`, and why an L1 created directly under a stack keeps its id verbatim.
 *   3. Otherwise: hash = first 8 hex chars (upper-cased) of MD5 of the components joined
 *      with `/` (`Resource` components ARE part of the hash).
 *   4. Human part = components with consecutive duplicates collapsed (`Foo/Foo` → `Foo`),
 *      `Resource` removed, non-alphanumerics removed, joined, truncated to 240 chars.
 *   5. ID = human part + hash.
 */
export function predictLogicalId(pathComponents: string[]): string {
  const components = pathComponents.filter((c) => c !== 'Default');
  if (components.length === 0) throw new Error('empty path');
  const alnum = (s: string) => s.replace(/[^A-Za-z0-9]/g, '');
  if (components.length === 1) return alnum(components[0]);

  const hash = crypto.createHash('md5').update(components.join('/')).digest('hex').slice(0, 8).toUpperCase();
  const deduped: string[] = [];
  for (const c of components) {
    if (deduped.length === 0 || !deduped[deduped.length - 1].endsWith(c)) deduped.push(c);
  }
  const human = deduped.filter((c) => c !== 'Resource').map(alnum).join('').slice(0, 240);
  return human + hash;
}

/**
 * A Stack subclass that overrides `allocateLogicalId` to add an environment prefix.
 *
 * Why anyone does this: teams migrating from hand-written CloudFormation sometimes need
 * logical IDs that match their old naming scheme, or want a stable prefix so that
 * CloudWatch/IAM references built by other tooling can pattern-match. The override is
 * called once per CfnElement during synthesis; it must be deterministic.
 *
 * `overrideLogicalId()` on an individual element still wins over this method: the
 * element's `logicalId` token resolves to the override *without consulting the stack*
 * (`CfnElement.synthesizeLogicalId`), so `stack.getLogicalId(el)` keeps returning the
 * allocated ID while the template shows the override. Use `stack.resolve(el.logicalId)`
 * when you want what the template will actually contain.
 */
export interface PrefixedIdsStackProps extends cdk.StackProps {
  readonly logicalIdPrefix: string;
}

export class PrefixedIdsStack extends cdk.Stack {
  private readonly prefix: string;
  readonly queue: sqs.Queue;
  readonly pinned: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: PrefixedIdsStackProps) {
    super(scope, id, props);
    this.prefix = props.logicalIdPrefix;

    this.queue = new sqs.Queue(this, 'Jobs', { enforceSSL: true });

    // The escape hatch for "we renamed the construct but must not replace the resource":
    // pin the logical ID to whatever the deployed template has.
    this.pinned = new ssm.StringParameter(this, 'RenamedParameter', { stringValue: 'v2' });
    (this.pinned.node.defaultChild as cdk.CfnResource).overrideLogicalId('LegacyParameter');
  }

  protected allocateLogicalId(cfnElement: cdk.CfnElement): string {
    const original = super.allocateLogicalId(cfnElement);
    // Leave the synthesizer's own elements alone: BootstrapVersion / CheckBootstrapVersion
    // are referenced by name in the CLI's bootstrap check.
    if (original === 'BootstrapVersion' || original === 'CheckBootstrapVersion' || original === 'CDKMetadata') {
      return original;
    }
    return `${this.prefix}${original}`;
  }
}

/** The three ways to ask CDK for an ID, side by side. */
export function describeIds(construct: Construct): { path: string; uniqueId: string; logicalId?: string; uniqueResourceName: string } {
  const cfn = construct.node.defaultChild;
  const stack = cdk.Stack.of(construct);
  return {
    path: construct.node.path,
    // Names.uniqueId hashes the FULL path (stack id included): safe as a global suffix.
    uniqueId: cdk.Names.uniqueId(construct),
    // The template-facing ID of the L1 (relative to the stack).
    logicalId: cfn && cdk.CfnElement.isCfnElement(cfn) ? stack.getLogicalId(cfn) : undefined,
    // For physical names: bounded length, chosen separator, path-derived, deterministic.
    uniqueResourceName: cdk.Names.uniqueResourceName(construct, { maxLength: 64, separator: '-' }),
  };
}
