import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvironmentTier } from '@cdk-mastery/shared';
import { retentionFor } from './network';

/**
 * The L3 route: `ApplicationLoadBalancedFargateService`.
 *
 * One construct gives you: cluster (if not passed), task definition + container with the
 * awslogs driver, an internet-facing ALB in the public subnets, an HTTP listener, a target
 * group, a Fargate service in the private subnets with a security group that only accepts
 * traffic from the ALB, and — when you ask — a circuit breaker. About 20 resources.
 *
 * When L3 is enough: one container, one port, HTTP(S) via ALB, standard health check,
 * no sidecars, no service discovery, no custom listener rules. That covers most internal
 * services. Everything the pattern exposes (`.service`, `.taskDefinition`,
 * `.loadBalancer`, `.listener`, `.targetGroup`, `.cluster`) is a normal L2 you can keep
 * configuring after construction — which is how you avoid dropping to L2 for the last 10%.
 *
 * When to drop to L2 (hand-built.ts): multiple containers/ports, a listener shared by
 * several services with path/host rules, gRPC/NLB, EXTERNAL deployment controllers,
 * capacity-provider strategies, or when you need to review every security-group rule in
 * a regulated environment.
 */
export interface PatternServiceStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
  readonly env: cdk.Environment;
  readonly vpc: ec2.IVpc;
}

export class PatternServiceStack extends cdk.Stack {
  readonly pattern: ecs_patterns.ApplicationLoadBalancedFargateService;
  readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: PatternServiceStackProps) {
    super(scope, id, props);

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      containerInsightsV2: props.tier.highlyAvailable ? ecs.ContainerInsights.ENHANCED : ecs.ContainerInsights.DISABLED,
    });

    // Own the log group so retention and removal are explicit (the pattern would create
    // one with infinite retention otherwise).
    this.logGroup = new logs.LogGroup(this, 'Logs', {
      retention: retentionFor(props.tier),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.pattern = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'Web', {
      cluster,
      cpu: 256,
      memoryLimitMiB: 512,
      desiredCount: props.tier.highlyAvailable ? 3 : 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      taskImageOptions: {
        // No Docker on the build machine: a public registry image, pulled by Fargate.
        image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:stable'),
        containerPort: 80,
        logDriver: ecs.LogDrivers.awsLogs({ logGroup: this.logGroup, streamPrefix: 'web' }),
        environment: { TIER: props.tier.name },
      },
      publicLoadBalancer: true,
      // Tasks in PRIVATE_WITH_EGRESS (the default when the VPC has them); no public IPs.
      assignPublicIp: false,
      // Roll back automatically when the new task set never becomes healthy.
      circuitBreaker: { enable: true, rollback: true },
      // Container-level health check (docker HEALTHCHECK equivalent); ALB health check is below.
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost/ || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(10),
      },
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });

    // --- Reaching into the L3 ------------------------------------------------------------
    // 1. The target group: tune the ALB health check and deregistration delay.
    this.pattern.targetGroup.configureHealthCheck({
      path: '/',
      healthyHttpCodes: '200-299',
      interval: cdk.Duration.seconds(15),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });
    this.pattern.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '30');

    // 2. The load balancer: idle timeout, drop invalid headers, access logs (bucket omitted here).
    this.pattern.loadBalancer.setAttribute('routing.http.drop_invalid_header_fields.enabled', 'true');
    this.pattern.loadBalancer.setAttribute('idle_timeout.timeout_seconds', '60');

    // 3. The service: autoscaling lives on the L2 service, not on the pattern.
    const scaling = this.pattern.service.autoScaleTaskCount({
      minCapacity: props.tier.highlyAvailable ? 3 : 1,
      maxCapacity: props.tier.highlyAvailable ? 12 : 2,
    });
    scaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(1),
    });
    scaling.scaleOnRequestCount('Requests', {
      requestsPerTarget: 200,
      targetGroup: this.pattern.targetGroup,
    });

    // 4. The listener: add a rule the pattern does not know about (e.g. block a path).
    this.pattern.listener.addAction('DenyInternal', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/internal/*'])],
      action: elbv2.ListenerAction.fixedResponse(403, { contentType: 'text/plain', messageBody: 'forbidden' }),
    });

    new cdk.CfnOutput(this, 'Url', { value: `http://${this.pattern.loadBalancer.loadBalancerDnsName}` });
  }
}
