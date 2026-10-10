import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { EnvironmentTier, resourceName } from '@cdk-mastery/shared';
import { Construct } from 'constructs';
import { ORG, SERVICE, sizingFor } from '../config';

export interface NetworkStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
}

/**
 * The VPC, sized by tier. Only the worker runs inside it (the API Lambda has no
 * reason to pay the ENI/cold-start tax). Gateway endpoints for DynamoDB and S3
 * mean the worker's data path never touches a NAT gateway — the NAT exists for
 * third-party HTTPS calls (payment provider, email) and is the single largest
 * fixed cost in the dev tier.
 */
export class NetworkStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly workerSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const sizing = sizingFor(props.tier);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: resourceName({ org: ORG, service: SERVICE, env: props.tier.name, component: 'vpc' }),
      ipAddresses: ec2.IpAddresses.cidr('10.40.0.0/16'),
      maxAzs: sizing.maxAzs,
      natGateways: sizing.natGateways,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
      ],
      gatewayEndpoints: {
        DynamoDb: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB },
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });

    // Flow logs: rejected traffic only — it is what you read during an incident,
    // and it is a fraction of the volume (and cost) of ALL.
    this.vpc.addFlowLog('RejectLog', {
      trafficType: ec2.FlowLogTrafficType.REJECT,
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'FlowLogs', {
          retention: retentionDays(props.tier.logRetentionDays),
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      ),
    });

    this.workerSecurityGroup = new ec2.SecurityGroup(this, 'WorkerSg', {
      vpc: this.vpc,
      description: 'Orders worker Lambda: egress to AWS endpoints and third-party HTTPS only',
      allowAllOutbound: false,
    });
    this.workerSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS egress (AWS APIs via endpoints/NAT, partners)');
  }
}

export function retentionDays(days: number): logs.RetentionDays {
  const values = Object.values(logs.RetentionDays).filter((v): v is number => typeof v === 'number');
  if (values.includes(days)) return days as logs.RetentionDays;
  return (values.filter((v) => v > days).sort((a, b) => a - b)[0] ?? logs.RetentionDays.INFINITE) as logs.RetentionDays;
}
