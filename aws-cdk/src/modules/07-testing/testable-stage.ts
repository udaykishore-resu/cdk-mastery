import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { EnvironmentTier } from '@cdk-mastery/shared';
import { Construct } from 'constructs';
import { TestableStack } from './testable-stack';

export interface TestableStageProps extends cdk.StageProps {
  readonly tier: EnvironmentTier;
}

/**
 * A Stage groups stacks into a deployable unit with its own cloud assembly
 * (`cdk.out/assembly-<StageName>/`). Pipelines deploy Stages; therefore tests
 * must be able to assert on a Stage, and `Template.fromStack` alone is not
 * enough — you also want "which stacks exist, with which names, in which env".
 * That is `app.synth()` + `assembly.getNestedAssembly(stage.artifactId)`.
 */
export class TestableStage extends cdk.Stage {
  readonly workload: TestableStack;
  readonly config: cdk.Stack;

  constructor(scope: Construct, id: string, props: TestableStageProps) {
    super(scope, id, props);

    this.workload = new TestableStack(this, 'Workload', { tier: props.tier });

    // A second stack that consumes an output of the first, so the assembly has a
    // dependency edge to assert on.
    this.config = new cdk.Stack(this, 'Config');
    new ssm.StringParameter(this.config, 'TableNameParam', {
      parameterName: `/cdk-mastery/07/${props.tier.name}/table-name`,
      stringValue: this.workload.table.tableName,
    });
  }
}
