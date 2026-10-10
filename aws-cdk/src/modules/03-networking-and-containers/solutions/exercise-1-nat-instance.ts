import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * Exercise 1 — replace the NAT gateway with a NAT instance in dev.
 *
 * A NAT gateway costs ~$32/month before traffic; a t4g.nano NAT instance ~$3. For a dev
 * VPC that mostly pulls images through ECR endpoints, the instance is fine. The trade:
 * no HA (single instance per AZ), ~5 Gbps burst, you patch it, and it can be stopped.
 * `NatProvider.instanceV2` uses the AL2023-based NAT AMI and IMDSv2; `instance` (v1) is
 * the deprecated Amazon Linux NAT AMI.
 *
 * Note the security group: the provider creates one that allows all inbound from the VPC
 * CIDR by default; `defaultAllowedTraffic: NONE` plus explicit `connections` rules is the
 * production shape if you ever run this outside dev.
 */
export interface CheapVpcProps {
  readonly cidr?: string;
}

export class CheapVpc extends Construct {
  readonly vpc: ec2.Vpc;
  readonly natProvider: ec2.NatInstanceProviderV2;

  constructor(scope: Construct, id: string, props: CheapVpcProps = {}) {
    super(scope, id);

    this.natProvider = ec2.NatProvider.instanceV2({
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      defaultAllowedTraffic: ec2.NatTrafficDirection.OUTBOUND_ONLY,
    });

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.cidr ?? '10.50.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      natGatewayProvider: this.natProvider,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
      ],
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
    });

    // Only the private subnets may send traffic through the NAT instance.
    this.natProvider.connections.allowFrom(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.allTraffic(), 'vpc egress via nat instance');
    cdk.Tags.of(this.natProvider.securityGroup).add('role', 'nat');
  }
}
