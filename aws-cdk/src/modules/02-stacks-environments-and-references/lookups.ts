import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvironmentTier } from '@cdk-mastery/shared';
import { platformParameterName } from './ssm-sharing';

/**
 * Context lookups: `Vpc.fromLookup`, `StringParameter.valueFromLookup`, `HostedZone.fromLookup`,
 * `MachineImage.lookup`, `Stack.availabilityZones` (for env-specific stacks).
 *
 * Mechanics. A lookup is a *context provider* call. At synth time the construct computes
 * a context KEY from its arguments and asks `scope.node.tryGetContext(key)`:
 *   - value present → used, synth continues with real data;
 *   - value absent  → the provider returns a DUMMY (`vpc-12345`, `dummy1a`,
 *     `dummy-value-for-<name>`), records `{ key, provider, props }` in the assembly's
 *     `manifest.missing`, and synth continues. The CLI sees `missing`, assumes the
 *     bootstrap **lookup role**, calls the AWS API, writes the answer to
 *     `cdk.context.json`, and re-runs synth. That is why a first `cdk synth` on a fresh
 *     clone can take two passes and why it needs credentials.
 *
 * Key format for VPCs (this is what ends up in cdk.context.json):
 *   vpc-provider:account=111111111111:filter.vpc-id=vpc-0123456789abcdef0:region=us-east-1:returnAsymmetricSubnets=true
 * and for SSM:
 *   ssm:account=111111111111:parameterName=/cdk-mastery/dev/platform/log-retention-days:region=us-east-1
 *
 * Why cdk.context.json is COMMITTED: the cached value makes synth deterministic and
 * credential-free for everyone (CI included), and a change to it shows up in code review
 * as the infrastructure change it is ("the prod VPC id changed"). Evict deliberately with
 * `cdk context --reset <key>` when the world changes. (This repo's .gitignore currently
 * lists aws-cdk/cdk.context.json — the integrator should remove that line before the
 * first real lookup is cached.)
 *
 * Tests and this module never hit the network: `LookupStack` seeds the exact key with a
 * realistic response via `this.node.setContext(...)`, which is what the CLI would have
 * written. Context is inherited down the tree, so setting it on the stack (before any
 * child exists) is equivalent to `new App({ context })` for everything inside.
 */

export const DUMMY_ACCOUNT = '111111111111';
export const DUMMY_REGION = 'us-east-1';
export const DUMMY_VPC_ID = 'vpc-0123456789abcdef0';

export function vpcLookupContextKey(account: string, region: string, vpcId: string): string {
  return `vpc-provider:account=${account}:filter.vpc-id=${vpcId}:region=${region}:returnAsymmetricSubnets=true`;
}

export function ssmLookupContextKey(account: string, region: string, parameterName: string): string {
  return `ssm:account=${account}:parameterName=${parameterName}:region=${region}`;
}

/** Shape: `VpcContextResponse` from @aws-cdk/cloud-assembly-api — exactly what the CLI caches. */
export function dummyVpcContext(region: string, vpcId: string): Record<string, unknown> {
  const az = (i: number) => `${region}${'abc'[i]}`;
  return {
    vpcId,
    vpcCidrBlock: '10.0.0.0/16',
    availabilityZones: [az(0), az(1)],
    subnetGroups: [
      {
        name: 'Public',
        type: 'Public',
        subnets: [
          { subnetId: 'subnet-0public00000000a', availabilityZone: az(0), routeTableId: 'rtb-0public0000000000', cidr: '10.0.0.0/24' },
          { subnetId: 'subnet-0public00000000b', availabilityZone: az(1), routeTableId: 'rtb-0public0000000000', cidr: '10.0.1.0/24' },
        ],
      },
      {
        name: 'Private',
        type: 'Private',
        subnets: [
          { subnetId: 'subnet-0private0000000a', availabilityZone: az(0), routeTableId: 'rtb-0private000000000a', cidr: '10.0.10.0/24' },
          { subnetId: 'subnet-0private0000000b', availabilityZone: az(1), routeTableId: 'rtb-0private000000000b', cidr: '10.0.11.0/24' },
        ],
      },
    ],
  };
}

export interface LookupStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
  /** Concrete env is mandatory: lookups need an account and region to build their key. */
  readonly env: cdk.Environment;
  readonly vpcId: string;
  /** When false the SSM value is left un-seeded to demonstrate `manifest.missing`. */
  readonly seedSsmValue?: boolean;
}

export class LookupStack extends cdk.Stack {
  readonly vpc: ec2.IVpc;
  readonly logRetentionDays: string;
  readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: LookupStackProps) {
    super(scope, id, props);
    const account = props.env.account!;
    const region = props.env.region!;

    // Seed the cache. In a real app this is the CLI's job and the values live in cdk.context.json.
    this.node.setContext(vpcLookupContextKey(account, region, props.vpcId), dummyVpcContext(region, props.vpcId));
    if (props.seedSsmValue ?? true) {
      this.node.setContext(ssmLookupContextKey(account, region, platformParameterName(props.tier, 'log-retention-days')), '30');
    }

    this.vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId });
    this.logRetentionDays = ssm.StringParameter.valueFromLookup(this, platformParameterName(props.tier, 'log-retention-days'));

    // Real data from the lookup flows into real resources: literal subnet ids and AZs.
    this.securityGroup = new ec2.SecurityGroup(this, 'AppSg', {
      vpc: this.vpc,
      description: `app sg in ${this.vpc.vpcId} (${this.vpc.availabilityZones.join(',')}); logs kept ${this.logRetentionDays} days`,
      allowAllOutbound: false,
    });
    this.securityGroup.addEgressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.tcp(443), 'to in-VPC endpoints');
  }
}
