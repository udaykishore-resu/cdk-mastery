import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface QualifiedStackProps extends cdk.StackProps {
  /**
   * Bootstrap qualifier. Must match what `cdk bootstrap --qualifier <q>` created in the
   * target account, otherwise the deploy role `cdk-<q>-deploy-role-...` does not exist.
   * Max 10 alphanumeric characters (it is embedded in IAM role and S3 bucket names).
   */
  readonly qualifier: string;
}

/**
 * Exercise 3 — make the bootstrap contract explicit.
 *
 * Every stack carries a hidden dependency on the bootstrap stack: the `BootstrapVersion`
 * parameter (default `/cdk-bootstrap/<qualifier>/version`, an SSM parameter *name*) and a
 * `CheckBootstrapVersion` rule that fails the deployment if the bootstrapped version is
 * older than the synthesizer requires. The qualifier is baked into every role and bucket
 * name the synthesizer emits. Teams that run several CDK "estates" in one account (e.g. a
 * platform team and a data team with separate permission boundaries) give each its own
 * qualifier so their bootstrap stacks and roles cannot collide.
 *
 * Two equivalent ways to set it:
 *   1. per stack:      `synthesizer: new DefaultStackSynthesizer({ qualifier })` (this file)
 *   2. app-wide:       context key `@aws-cdk/core:bootstrapQualifier` in cdk.json
 */
export class QualifiedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: QualifiedStackProps) {
    super(scope, id, {
      ...props,
      synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: props.qualifier }),
    });

    // A real resource so the template is not empty (the built-in CloudFormation-Validate
    // plugin flags empty Resources sections).
    new ssm.StringParameter(this, 'Marker', {
      parameterName: `/cdk-mastery/${props.qualifier}/marker`,
      stringValue: 'bootstrapped-with-custom-qualifier',
    });
  }
}
