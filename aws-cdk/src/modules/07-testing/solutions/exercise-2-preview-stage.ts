import * as cdk from 'aws-cdk-lib';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import { Construct } from 'constructs';
import { TestableStack } from '../testable-stack';

export interface PreviewStageProps extends cdk.StageProps {
  /** Pull-request number; becomes part of every stack name so previews never collide. */
  readonly prNumber: number;
}

/**
 * Exercise 2 — an ephemeral "preview per pull request" Stage.
 *
 * Requirements the tests pin down:
 *   1. Every stack name starts with `pr-<n>-` (explicit `stackName`, because the
 *      default `<StageId>-<StackId>` would be `Preview42-Workload`).
 *   2. Everything is destroyable: `RemovalPolicies.of(this).destroy()` overrides
 *      any RETAIN a construct set, so `cdk destroy` leaves nothing behind. It is
 *      an aspect (MUTATING priority with the flag), applied at the Stage.
 *   3. It always uses the dev tier — a preview must never inherit prod settings.
 *
 * Testing a Stage means `app.synth()` and reading the nested assembly:
 *   const asm = app.synth().getNestedAssembly(stage.artifactId);
 *   asm.getStackByName('pr-42-workload')
 */
export class PreviewStage extends cdk.Stage {
  readonly workload: TestableStack;

  constructor(scope: Construct, id: string, props: PreviewStageProps) {
    super(scope, id, props);
    const prefix = `pr-${props.prNumber}`;

    this.workload = new TestableStack(this, 'Workload', {
      tier: ENVIRONMENTS.dev,
      stackName: `${prefix}-workload`,
      enableDlq: false, // previews are short-lived; the warning annotation is expected here
    });

    cdk.RemovalPolicies.of(this).destroy();
    cdk.Tags.of(this).add('preview', prefix);
  }
}
