import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface ParameterReaderProps {
  readonly parameterName: string;
  /**
   * Bump to force a re-read on the next deploy. CloudFormation only sends an
   * Update when a *property* changes; a read with identical properties is
   * never re-executed, so "latest value" needs a nudge you control.
   * @default 1
   */
  readonly version?: number;
}

/**
 * Exercise 2 — read a value at deploy time with `AwsCustomResource`.
 *
 * `ssm.StringParameter.valueForStringParameter` gives you a CloudFormation
 * dynamic reference (`{{resolve:ssm:...}}`) — cheaper and better for most cases.
 * The SDK-call version is for what dynamic references cannot do: parameters in
 * *another account/region* (`assumedRoleArn` / `region` on the call), decrypting
 * with a specific key, or any API that is not SSM (`describe*` calls, feature
 * detection). The value comes back through `getResponseField`, which becomes a
 * `Fn::GetAtt` on the custom resource — so it is a token you can use anywhere.
 *
 * `PhysicalResourceId.of(parameterName)` keeps the id constant: the resource is
 * updated in place, never replaced. For a read, returning a new physical id
 * (`fromResponse`) would be wrong: CloudFormation would then send a Delete for
 * the "old" resource.
 */
export class ParameterReader extends Construct {
  readonly value: string;

  constructor(scope: Construct, id: string, props: ParameterReaderProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const parameterArn = stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: props.parameterName.replace(/^\//, '') });

    const read: cr.AwsSdkCall = {
      service: 'SSM',
      action: 'GetParameter',
      parameters: { Name: props.parameterName, WithDecryption: true },
      physicalResourceId: cr.PhysicalResourceId.of(props.parameterName),
    };

    const resource = new cr.AwsCustomResource(this, 'Resource', {
      resourceType: 'Custom::SsmParameterReader',
      onCreate: read,
      onUpdate: read,
      // No onDelete: a read has nothing to tear down.
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [parameterArn] }),
      installLatestAwsSdk: false,
      logGroup: new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
    // The version is smuggled in as a property so CloudFormation sees a change.
    // AwsCustomResource → CustomResource ('Resource') → CfnResource ('Default'): two hops to the L1.
    const cfn = resource.node.findChild('Resource').node.defaultChild as cdk.CfnResource;
    cfn.addPropertyOverride('Version', props.version ?? 1);

    this.value = resource.getResponseField('Parameter.Value');
  }
}
