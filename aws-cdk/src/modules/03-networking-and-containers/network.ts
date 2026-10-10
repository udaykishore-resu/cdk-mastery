import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvironmentTier } from '@cdk-mastery/shared';

/**
 * A cost-aware VPC.
 *
 * What the L2 creates for `maxAzs: 2`, three subnet groups, `natGateways: 1`:
 *   VPC, IGW + attachment, 6 subnets, 6 route tables + associations, 1 EIP + 1 NAT gateway,
 *   default routes (public → IGW, private → NAT), plus a security group restriction custom
 *   resource — roughly 30 resources before endpoints. Multiply NAT by AZ count for HA.
 *
 * Where the money goes (us-east-1 list prices, order of magnitude):
 *   - NAT gateway: ~$32/month per gateway PLUS $0.045/GB processed. One NAT per AZ in prod
 *     (an AZ outage must not take out egress for the others); one NAT total in dev.
 *   - Interface endpoints: ~$7/month per endpoint per AZ, plus $0.01/GB. Each one you add
 *     avoids NAT data-processing charges for that service AND keeps traffic off the internet.
 *     For a container platform, ECR (api + dkr), CloudWatch Logs and Secrets Manager pay for
 *     themselves at modest pull volume; S3 and DynamoDB *gateway* endpoints are free — always add them.
 *   - Flow logs: CloudWatch Logs ingestion is the cost; keep retention short in dev.
 *
 * Subnet groups:
 *   Public   — load balancers, NAT gateways. Nothing with a private IP you care about.
 *   Private  — PRIVATE_WITH_EGRESS: tasks, Lambda-in-VPC; reach the internet via NAT.
 *   Isolated — PRIVATE_ISOLATED: databases, caches; no route out at all. Endpoints only.
 */
export interface NetworkStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
  /** Concrete env: the VPC L2 needs real AZ names to place subnets (lookup, cached in cdk.context.json). */
  readonly env: cdk.Environment;
  /** Override the AZ count; defaults to 3 for highly-available tiers, 2 otherwise. */
  readonly maxAzs?: number;
}

export class NetworkStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly natGatewayCount: number;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const maxAzs = props.maxAzs ?? (props.tier.highlyAvailable ? 3 : 2);
    // dev: a single NAT (one AZ's egress can fail, that is acceptable); prod: one per AZ.
    this.natGatewayCount = props.tier.highlyAvailable ? maxAzs : 1;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.40.0.0/16'),
      maxAzs,
      natGateways: this.natGatewayCount,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      // Free. Route S3/DynamoDB traffic through the gateway instead of NAT.
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
        DynamoDb: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB },
      },
      flowLogs: {
        Rejected: {
          trafficType: ec2.FlowLogTrafficType.REJECT,
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, 'FlowLogs', {
              retention: retentionFor(props.tier),
              removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
          ),
        },
      },
      // Removes the default SG's allow-all rules via a custom resource (flag-driven in cdk.json;
      // explicit here so tests with a bare App behave the same).
      restrictDefaultSecurityGroup: true,
    });

    // Interface endpoints: paid, per AZ. These four are the minimum for a Fargate service
    // that pulls from ECR, logs to CloudWatch and reads secrets without touching NAT.
    // `privateDnsEnabled` (default true) makes the SDK's normal hostnames resolve to the endpoint.
    const endpoints: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
      EcrDocker: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      Logs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    };
    for (const [id, service] of Object.entries(endpoints)) {
      // Placed in the private subnets; the endpoint's own security group must allow 443
      // from whoever uses it — see `allowEndpointAccess` below and the `connections` API.
      this.vpc.addInterfaceEndpoint(id, { service, subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS } });
    }
  }

  /**
   * The `connections` API in one call: every interface endpoint accepts 443 from `client`.
   * `IConnectable` is anything with `.connections` — a service, a Lambda, a SG, an ALB.
   * Rules are written on BOTH security groups when both sides are known (ingress on the
   * endpoint SG, egress on the client SG when the client is not allowAllOutbound).
   */
  allowEndpointAccess(client: ec2.IConnectable): void {
    for (const child of this.vpc.node.children) {
      if (child instanceof ec2.InterfaceVpcEndpoint) child.connections.allowDefaultPortFrom(client);
    }
  }
}

export function retentionFor(tier: EnvironmentTier): logs.RetentionDays {
  const map: Record<number, logs.RetentionDays> = {
    7: logs.RetentionDays.ONE_WEEK,
    30: logs.RetentionDays.ONE_MONTH,
    365: logs.RetentionDays.ONE_YEAR,
  };
  return map[tier.logRetentionDays] ?? logs.RetentionDays.ONE_MONTH;
}
