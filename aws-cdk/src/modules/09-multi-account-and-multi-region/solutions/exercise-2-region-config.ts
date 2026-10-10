import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface RegionConfigProps {
  /** Per-region values; every region the stack may deploy to must be listed. */
  readonly byRegion: Record<string, Record<string, string>>;
}

/**
 * Exercise 2 — per-region configuration that survives env-agnostic stacks.
 *
 * Two ways to vary a value by region:
 *   (a) in code, `if (Stack.of(this).region === 'eu-west-1')` — only works for
 *       stacks with a concrete env, silently wrong for env-agnostic ones
 *       (the comparison is against a token string and is always false);
 *   (b) a `CfnMapping` + `Fn::FindInMap` keyed on `AWS::Region` — resolved by
 *       CloudFormation, works for both.
 *
 * This construct does (b) and adds the one thing `CfnMapping` lacks: a synth-time
 * error when the stack *does* have a concrete region that the mapping does not
 * cover. Note `lazy: true`: when both keys are concrete, `findInMap` resolves to
 * the literal at synth time and the Mappings section is not even rendered.
 */
export class RegionConfig extends Construct {
  private readonly mapping: cdk.CfnMapping;

  constructor(scope: Construct, id: string, props: RegionConfigProps) {
    super(scope, id);
    const region = cdk.Stack.of(this).region;
    if (!cdk.Token.isUnresolved(region) && !(region in props.byRegion)) {
      throw new Error(`RegionConfig has no entry for region ${region}; known: ${Object.keys(props.byRegion).join(', ')}`);
    }
    this.mapping = new cdk.CfnMapping(this, 'Mapping', { mapping: props.byRegion, lazy: true });
  }

  /**
   * A token (`Fn::FindInMap` on `AWS::Region`) for env-agnostic stacks, or the
   * literal value when the stack's region is concrete. `Aws.REGION` is *always*
   * `{ Ref: AWS::Region }`; `Stack.of(this).region` is the literal when known —
   * pass the latter so the lazy mapping can short-circuit at synth time.
   */
  get(key: string): string {
    const region = cdk.Stack.of(this).region;
    return this.mapping.findInMap(cdk.Token.isUnresolved(region) ? cdk.Aws.REGION : region, key);
  }
}
