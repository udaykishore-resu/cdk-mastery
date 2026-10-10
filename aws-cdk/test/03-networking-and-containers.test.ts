import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import { addToApp, HandBuiltServiceStack, NetworkStack, PatternServiceStack } from '../src/modules/03-networking-and-containers';
import { CheapVpc } from '../src/modules/03-networking-and-containers/solutions/exercise-1-nat-instance';
import { addHttpsWithRedirect } from '../src/modules/03-networking-and-containers/solutions/exercise-2-https-listener';
import { SpotWorker } from '../src/modules/03-networking-and-containers/solutions/exercise-3-spot-worker';

const ENV = { account: '111111111111', region: 'us-east-1' };
const WEAK = { '@aws-cdk/core:defaultCrossStackReferences': 'weak' };
const dev = ENVIRONMENTS.dev;
const prod = ENVIRONMENTS.prod;

describe('03 · NetworkStack', () => {
  const devNet = new NetworkStack(new cdk.App(), 'M03-Network', { tier: dev, env: ENV });
  const prodNet = new NetworkStack(new cdk.App(), 'M03-Network', { tier: prod, env: ENV });
  const devT = Template.fromStack(devNet);
  const prodT = Template.fromStack(prodNet);

  test('three subnet groups per AZ, sized by the tier', () => {
    devT.resourceCountIs('AWS::EC2::Subnet', 6); // 3 groups x 2 AZs
    prodT.resourceCountIs('AWS::EC2::Subnet', 9); // 3 groups x 3 AZs
    devT.hasResourceProperties('AWS::EC2::Subnet', { CidrBlock: '10.40.0.0/24', MapPublicIpOnLaunch: true });
    devT.hasResourceProperties('AWS::EC2::Subnet', { CidrBlock: Match.stringLikeRegexp('/22$'), MapPublicIpOnLaunch: false });
  });

  test('NAT gateways: one in dev, one per AZ in prod', () => {
    devT.resourceCountIs('AWS::EC2::NatGateway', 1);
    prodT.resourceCountIs('AWS::EC2::NatGateway', 3);
    expect(devNet.natGatewayCount).toBe(1);
    expect(prodNet.natGatewayCount).toBe(3);
    // isolated subnets have no route to a NAT; private subnets do
    const routes = devT.findResources('AWS::EC2::Route', { Properties: { NatGatewayId: Match.anyValue() } });
    expect(Object.keys(routes)).toHaveLength(2); // one per private subnet
  });

  test('free gateway endpoints for S3 and DynamoDB, paid interface endpoints for the container path', () => {
    devT.resourcePropertiesCountIs('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway' }, 2);
    devT.resourcePropertiesCountIs('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Interface', PrivateDnsEnabled: true }, 4);
    devT.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: 'com.amazonaws.us-east-1.ecr.dkr', // literal: the stack is env-specific
      VpcEndpointType: 'Interface',
    });
  });

  test('flow logs for rejected traffic go to a log group with tier retention', () => {
    devT.hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'REJECT', LogDestinationType: 'cloud-watch-logs' });
    devT.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
    prodT.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 365 });
  });

  test('the default security group is stripped by a custom resource', () => {
    devT.resourceCountIs('Custom::VpcRestrictDefaultSG', 1);
  });

  test('allowEndpointAccess writes 443 ingress on every interface endpoint SG from the client', () => {
    const app = new cdk.App();
    const net = new NetworkStack(app, 'N', { tier: dev, env: ENV });
    const client = new ec2.SecurityGroup(net, 'Client', { vpc: net.vpc, allowAllOutbound: false });
    net.allowEndpointAccess(client);
    const t = Template.fromStack(net);
    t.resourcePropertiesCountIs('AWS::EC2::SecurityGroupIngress', { FromPort: 443, ToPort: 443, IpProtocol: 'tcp', SourceSecurityGroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Client'), 'GroupId'] } }, 4);
    // and, because the client is not allow-all-outbound, matching egress rules on the client side
    t.resourcePropertiesCountIs('AWS::EC2::SecurityGroupEgress', { FromPort: 443, GroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Client'), 'GroupId'] } }, 4);
  });
});

describe('03 · PatternServiceStack (L3)', () => {
  const app = new cdk.App({ context: WEAK });
  const net = new NetworkStack(app, 'M03-Network', { tier: dev, env: ENV });
  const stack = new PatternServiceStack(app, 'M03-PatternService', { tier: dev, env: ENV, vpc: net.vpc });
  const t = Template.fromStack(stack);

  test('one construct produces ALB, listener, target group, task definition and service', () => {
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
    t.resourceCountIs('AWS::ECS::TaskDefinition', 1);
    t.resourceCountIs('AWS::ECS::Service', 1);
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internet-facing', Type: 'application' });
  });

  test('image from a public registry, awslogs driver into our log group, circuit breaker on', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '256',
      Memory: '512',
      RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
      ContainerDefinitions: [
        Match.objectLike({
          Image: 'public.ecr.aws/nginx/nginx:stable',
          LogConfiguration: { LogDriver: 'awslogs', Options: Match.objectLike({ 'awslogs-group': { Ref: Match.stringLikeRegexp('^Logs') }, 'awslogs-stream-prefix': 'web' }) },
          HealthCheck: Match.objectLike({ Command: ['CMD-SHELL', 'curl -f http://localhost/ || exit 1'], Retries: 3 }),
          PortMappings: [{ ContainerPort: 80, Protocol: 'tcp' }],
        }),
      ],
    });
    t.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: { DeploymentCircuitBreaker: { Enable: true, Rollback: true }, MinimumHealthyPercent: 100, MaximumPercent: 200 },
      NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }) },
    });
    t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  });

  test('reaching into the L3: health check, LB attributes, autoscaling on CPU + requests, listener rule', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/',
      HealthCheckIntervalSeconds: 15,
      Matcher: { HttpCode: '200-299' },
      TargetGroupAttributes: Match.arrayWith([{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }]),
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([{ Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' }]),
    });
    t.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', { MinCapacity: 1, MaxCapacity: 2, ServiceNamespace: 'ecs' });
    t.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({ PredefinedMetricSpecification: { PredefinedMetricType: 'ECSServiceAverageCPUUtilization' }, TargetValue: 60 }),
    });
    t.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({ PredefinedMetricSpecification: Match.objectLike({ PredefinedMetricType: 'ALBRequestCountPerTarget' }), TargetValue: 200 }),
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 10,
      Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/internal/*'] } }],
      Actions: [Match.objectLike({ Type: 'fixed-response', FixedResponseConfig: Match.objectLike({ StatusCode: '403' }) })],
    });
  });

  test('the pattern exposes its L2s', () => {
    expect(stack.pattern.service).toBeInstanceOf(ecs.FargateService);
    expect(stack.pattern.loadBalancer).toBeInstanceOf(elbv2.ApplicationLoadBalancer);
    expect(stack.pattern.targetGroup).toBeInstanceOf(elbv2.ApplicationTargetGroup);
    expect(stack.pattern.listener).toBeInstanceOf(elbv2.ApplicationListener);
  });

  test('the service SG only accepts traffic from the ALB SG (not a CIDR)', () => {
    t.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 80,
      ToPort: 80,
      GroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^WebServiceSecurityGroup'), 'GroupId'] },
      SourceSecurityGroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^WebLBSecurityGroup'), 'GroupId'] },
    });
  });
});

describe('03 · HandBuiltServiceStack (L2)', () => {
  const app = new cdk.App({ context: WEAK });
  const net = new NetworkStack(app, 'M03-Network', { tier: prod, env: ENV });
  const stack = new HandBuiltServiceStack(app, 'M03-HandBuiltService', { tier: prod, env: ENV, vpc: net.vpc });
  const t = Template.fromStack(stack);

  test('the same shape as the pattern, with prod sizing', () => {
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    t.resourceCountIs('AWS::ECS::Service', 1);
    t.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 3,
      HealthCheckGracePeriodSeconds: 60,
      AvailabilityZoneRebalancing: 'ENABLED',
      EnableExecuteCommand: false,
      DeploymentConfiguration: { DeploymentCircuitBreaker: { Enable: true, Rollback: true } },
    });
    t.hasResourceProperties('AWS::ECS::Cluster', { ClusterSettings: [{ Name: 'containerInsights', Value: 'enhanced' }] });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { TargetType: 'ip', HealthCheckPath: '/', HealthCheckTimeoutSeconds: 5 });
    t.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', { MinCapacity: 3, MaxCapacity: 12 });
  });

  test('awslogs non-blocking mode with a buffer, and a 365-day log group', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        Match.objectLike({
          LogConfiguration: { LogDriver: 'awslogs', Options: Match.objectLike({ mode: 'non-blocking', 'max-buffer-size': '26214400b' }) },
        }),
      ],
    });
    t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 365 });
  });

  test('connections: ALB -> service on 80, service -> database on 5432, service egress otherwise 443 only', () => {
    const serviceSg = { 'Fn::GetAtt': [Match.stringLikeRegexp('^ServiceSg'), 'GroupId'] };
    const albSg = { 'Fn::GetAtt': [Match.stringLikeRegexp('^AlbSecurityGroup'), 'GroupId'] };
    const dbSg = { 'Fn::GetAtt': [Match.stringLikeRegexp('^DatabaseSg'), 'GroupId'] };
    // ALB -> service (written by targetGroup.addTarget(service))
    t.hasResourceProperties('AWS::EC2::SecurityGroupIngress', { FromPort: 80, GroupId: serviceSg, SourceSecurityGroupId: albSg });
    // service -> db: ingress on the db SG AND egress on the service SG (not allow-all-outbound)
    t.hasResourceProperties('AWS::EC2::SecurityGroupIngress', { FromPort: 5432, ToPort: 5432, GroupId: dbSg, SourceSecurityGroupId: serviceSg, Description: 'app -> postgres' });
    t.hasResourceProperties('AWS::EC2::SecurityGroupEgress', { FromPort: 5432, GroupId: serviceSg, DestinationSecurityGroupId: dbSg });
    // service SG inline egress: 443 to anywhere only
    t.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'web service tasks',
      SecurityGroupEgress: [Match.objectLike({ CidrIp: '0.0.0.0/0', FromPort: 443, ToPort: 443, IpProtocol: 'tcp' })],
    });
    // db SG has no egress at all (allowAllOutbound false + nothing granted => the 255.255.255.255/32 placeholder)
    t.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Postgres (stand-in) - only the service may connect',
      SecurityGroupEgress: [Match.objectLike({ CidrIp: '255.255.255.255/32' })],
    });
  });

  test('the task role and execution role are distinct', () => {
    const td = Object.values(t.findResources('AWS::ECS::TaskDefinition'))[0];
    expect(td.Properties.TaskRoleArn).not.toEqual(td.Properties.ExecutionRoleArn);
  });
});

describe('03 · exercises', () => {
  test('exercise 1: NAT instance instead of NAT gateway', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S', { env: ENV });
    const cheap = new CheapVpc(stack, 'Cheap');
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::EC2::NatGateway', 0);
    t.resourceCountIs('AWS::EC2::Instance', 1);
    t.hasResourceProperties('AWS::EC2::Instance', { InstanceType: 't4g.nano', SourceDestCheck: false });
    expect(cheap.vpc.privateSubnets).toHaveLength(2);
    t.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: [Match.objectLike({ CidrIp: { 'Fn::GetAtt': [Match.stringLikeRegexp('^CheapVpc'), 'CidrBlock'] }, IpProtocol: '-1', Description: 'vpc egress via nat instance' })],
    });
  });

  test('exercise 2: HTTPS listener with recommended TLS policy and an HTTP redirect', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S', { env: ENV });
    const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: 0 });
    const alb = new elbv2.ApplicationLoadBalancer(stack, 'Alb', { vpc, internetFacing: true });
    const tg = new elbv2.ApplicationTargetGroup(stack, 'Tg', { vpc, port: 80, targetType: elbv2.TargetType.IP });
    const { https, redirect } = addHttpsWithRedirect(stack, 'Tls', { loadBalancer: alb, targetGroup: tg, certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/abc' });
    expect(https).toBeInstanceOf(elbv2.ApplicationListener);
    expect(redirect).toBeInstanceOf(elbv2.ApplicationListener);
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      Certificates: [{ CertificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/abc' }],
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [{ Type: 'redirect', RedirectConfig: Match.objectLike({ Port: '443', Protocol: 'HTTPS', StatusCode: 'HTTP_301' }) }],
    });
    t.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([Match.objectLike({ FromPort: 443, CidrIp: '0.0.0.0/0' }), Match.objectLike({ FromPort: 80, CidrIp: '0.0.0.0/0' })]),
    });
  });

  test('exercise 3: Spot capacity strategy, injected secret, queue-depth scaling, least-privilege task role', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S', { env: ENV });
    // natGateways: 0 turns PRIVATE_WITH_EGRESS into isolated subnets; keep one so the worker has a private group.
    const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: 1 });
    const cluster = new ecs.Cluster(stack, 'Cluster', { vpc, enableFargateCapacityProviders: true });
    const queue = new sqs.Queue(stack, 'Jobs');
    const secret = new secretsmanager.Secret(stack, 'Db');
    const logGroup = new logs.LogGroup(stack, 'Logs');
    const worker = new SpotWorker(stack, 'Worker', { vpc, cluster, queue, databaseSecret: secret, logGroup });
    const t = Template.fromStack(stack);

    t.hasResourceProperties('AWS::ECS::Service', {
      CapacityProviderStrategy: [
        { CapacityProvider: 'FARGATE', Base: 1, Weight: 1 },
        { CapacityProvider: 'FARGATE_SPOT', Weight: 3 },
      ],
    });
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        Match.objectLike({
          StopTimeout: 120,
          Secrets: [{ Name: 'DB_PASSWORD', ValueFrom: { 'Fn::Join': ['', [{ Ref: Match.stringLikeRegexp('^Db') }, ':password::']] } }],
        }),
      ],
    });
    // the task role may only consume the queue; the execution role reads the secret
    const taskRoleId = stack.getLogicalId(worker.taskDefinition.taskRole.node.defaultChild as cdk.CfnResource);
    t.hasResourceProperties('AWS::IAM::Policy', {
      Roles: [{ Ref: taskRoleId }],
      PolicyDocument: { Statement: [Match.objectLike({ Action: Match.arrayWith(['sqs:ReceiveMessage', 'sqs:DeleteMessage']) })] },
    });
    t.hasResourceProperties('AWS::IAM::Policy', {
      Roles: [{ Ref: Match.stringLikeRegexp('ExecutionRole') }],
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'] })]) },
    });
    t.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      PolicyType: 'StepScaling',
      StepScalingPolicyConfiguration: Match.objectLike({ AdjustmentType: 'ChangeInCapacity' }),
    });
  });
});

describe('03 · addToApp', () => {
  test('three env-specific stacks; services depend on the network', () => {
    const app = new cdk.App({ context: WEAK });
    addToApp(app);
    const stacks = app.node.children.filter((c): c is cdk.Stack => cdk.Stack.isStack(c));
    expect(stacks.map((s) => s.stackName).sort()).toEqual(['M03-HandBuiltService', 'M03-Network', 'M03-PatternService']);
    for (const s of stacks) expect(s.region).toBe('us-east-1');
    const byName = Object.fromEntries(stacks.map((s) => [s.stackName, s]));
    for (const name of ['M03-PatternService', 'M03-HandBuiltService']) {
      Template.fromStack(byName[name]); // implicit dependencies are recorded at synth
      expect(byName[name].dependencies).toContain(byName['M03-Network']);
    }
  });
});
