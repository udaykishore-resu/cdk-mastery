import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvironmentTier } from '@cdk-mastery/shared';
import { retentionFor } from './network';

/**
 * The same service, hand-built from L2s. Compare with pattern-service.ts line by line: every
 * decision the pattern made for you is now a line you own.
 *
 * Order of construction mirrors the data path: cluster → task definition → container →
 * ALB → listener → target group → service → security-group wiring → autoscaling.
 */
export interface HandBuiltServiceStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
  readonly env: cdk.Environment;
  readonly vpc: ec2.IVpc;
}

export class HandBuiltServiceStack extends cdk.Stack {
  readonly cluster: ecs.Cluster;
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly service: ecs.FargateService;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly listener: elbv2.ApplicationListener;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  /** Stands in for a database: shows the `connections` API between two IConnectables. */
  readonly databaseSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: HandBuiltServiceStackProps) {
    super(scope, id, props);
    const ha = props.tier.highlyAvailable;

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      containerInsightsV2: ha ? ecs.ContainerInsights.ENHANCED : ecs.ContainerInsights.DISABLED,
      // `ecs exec` needs this plus `enableExecuteCommand` on the service. Off by default here.
    });

    // --- Task definition -------------------------------------------------------------------
    // cpu/memory are Fargate "task sizes"; the pair must be a valid combination (256/512, 512/1024, ...).
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      // executionRole: pulls the image and writes logs (created on demand by the L2).
      // taskRole: what the *application* may call. Use grant* on it; never share with executionRole.
    });

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: retentionFor(props.tier),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const container = this.taskDefinition.addContainer('Web', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:stable'),
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'web',
        // NON_BLOCKING drops logs under backpressure instead of blocking stdout; BLOCKING (default)
        // is safer for audit logs, worse for availability.
        mode: ecs.AwsLogDriverMode.NON_BLOCKING,
        maxBufferSize: cdk.Size.mebibytes(25),
      }),
      environment: { TIER: props.tier.name },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost/ || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(10),
      },
      // Fail fast if the container cannot start; ECS reports the stopped reason.
      essential: true,
      readonlyRootFilesystem: false, // nginx writes to /var/cache/nginx and /var/run
    });
    container.addPortMappings({ containerPort: 80, protocol: ecs.Protocol.TCP });

    // --- Load balancer, listener, target group --------------------------------------------
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      dropInvalidHeaderFields: true,
      idleTimeout: cdk.Duration.seconds(60),
    });

    this.listener = this.loadBalancer.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      // `open: true` (the default) adds 0.0.0.0/0 ingress on the ALB SG. Explicit so reviewers see it.
      open: true,
    });

    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'Targets', {
      vpc: props.vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP, // Fargate tasks are IP targets, never instance targets
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200-299',
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });
    this.listener.addTargetGroups('Default', { targetGroups: [this.targetGroup] });

    // --- Service ---------------------------------------------------------------------------
    // Own the service security group so egress is explicit. The L2 default is a SG with
    // allow-all egress, which makes every later `connections.allowTo` a no-op on this side.
    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSg', {
      vpc: props.vpc,
      description: 'web service tasks',
      allowAllOutbound: false,
    });
    serviceSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS to endpoints and registries');

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: ha ? 3 : 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [serviceSg],
      assignPublicIp: false,
      circuitBreaker: { enable: true, rollback: true },
      // Time the ALB gives new tasks before health checks count. Too short = deploy flaps.
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      enableExecuteCommand: !ha,
      availabilityZoneRebalancing: ha ? ecs.AvailabilityZoneRebalancing.ENABLED : ecs.AvailabilityZoneRebalancing.DISABLED,
    });
    this.targetGroup.addTarget(this.service);

    // --- The `connections` API -------------------------------------------------------------
    // `addTarget` above already did `service.connections.allowFrom(alb, port 80)` for us:
    // an ingress rule on the service SG from the ALB SG (not from a CIDR). The ALB SG's
    // egress is allowAllOutbound, so no egress rule is needed on that side.
    //
    // A database the service must reach: both sides are IConnectable, so one statement
    // writes an ingress rule on the DB SG *and*, because the service SG is not
    // allow-all-outbound, an egress rule on the service SG. Peers are SG references, so
    // task IPs can change freely. `allowFrom(x)` here is identical to `x.connections.allowTo(this)`.
    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc: props.vpc,
      description: 'Postgres (stand-in) - only the service may connect',
      allowAllOutbound: false,
    });
    this.databaseSecurityGroup.connections.allowFrom(this.service, ec2.Port.tcp(5432), 'app -> postgres');

    // --- Autoscaling -----------------------------------------------------------------------
    const scaling = this.service.autoScaleTaskCount({ minCapacity: ha ? 3 : 1, maxCapacity: ha ? 12 : 2 });
    scaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(1),
    });
    scaling.scaleOnRequestCount('Requests', { requestsPerTarget: 200, targetGroup: this.targetGroup });

    new cdk.CfnOutput(this, 'Url', { value: `http://${this.loadBalancer.loadBalancerDnsName}` });
  }
}
