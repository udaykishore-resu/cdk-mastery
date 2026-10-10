import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { EnvironmentTier, resourceName } from '@cdk-mastery/shared';
import { Construct } from 'constructs';
import { ORG, SERVICE, sizingFor } from '../config';
import { retentionDays } from './network-stack';

export interface ApiStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
  /**
   * The table is referenced by *name*, not by passing the `TableV2` object.
   * A construct reference would render `Fn::ImportValue` (strong) or
   * `Fn::GetStackOutput` (weak) into every IAM statement, coupling this stack's
   * template to the Data stack's export names. The name is deterministic
   * (`resourceName`), so the consumer rebuilds the ARN locally; the KMS key is
   * still passed as a reference, which keeps the Data → Api deploy order.
   */
  readonly tableName: string;
  readonly tableKey: kms.IKey;
}

/**
 * HTTP API → Lambda → DynamoDB, and an EventBridge bus the API publishes to.
 *
 * Choices explained:
 *  - HTTP API (v2) over REST API: 70% cheaper per request, lower latency, and
 *    we need none of REST's request validation / usage plans. Access logging is
 *    configured on the stage (JSON, standard fields) because the *first* thing
 *    you need in an incident is the request id ↔ Lambda request id join.
 *  - `lambda.Function` with `Code.fromAsset` on plain JS: no bundling step, no
 *    Docker/esbuild in CI, ~10 KB asset. `NodejsFunction` is the right choice
 *    once the handler has dependencies beyond the runtime's SDK.
 *  - The custom event bus is owned by the API stack because the API is the
 *    producer; the worker stack subscribes. Producer owns the bus, consumers
 *    own their rules — that is the ownership model that survives more teams.
 *  - Authorization: data routes use the IAM authorizer (callers sign with
 *    SigV4 — this is an internal API behind a BFF/gateway); `/health` is
 *    intentionally open for the load balancer and the pipeline smoke test.
 */
export class ApiStack extends cdk.Stack {
  readonly api: apigw.HttpApi;
  readonly handler: lambda.Function;
  readonly bus: events.EventBus;
  readonly table: dynamodb.ITableV2;
  readonly healthRoute: apigw.HttpRoute;
  readonly apiUrlOutput: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { tier } = props;
    const sizing = sizingFor(tier);
    const retention = retentionDays(tier.logRetentionDays);

    this.table = dynamodb.TableV2.fromTableAttributes(this, 'OrdersTable', { tableName: props.tableName, encryptionKey: props.tableKey });

    this.bus = new events.EventBus(this, 'Bus', {
      eventBusName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'events' }),
    });

    this.handler = new lambda.Function(this, 'Handler', {
      functionName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'api' }),
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'api.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'handlers')),
      memorySize: sizing.apiMemoryMb,
      timeout: cdk.Duration.seconds(10),
      architecture: lambda.Architecture.ARM_64, // ~20% cheaper per GB-second; the handler has no native deps
      environment: { TABLE_NAME: this.table.tableName, EVENT_BUS_NAME: this.bus.eventBusName },
      logGroup: new logs.LogGroup(this, 'HandlerLogs', { retention, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      tracing: lambda.Tracing.ACTIVE,
    });
    this.table.grantReadWriteData(this.handler);
    this.bus.grantPutEventsTo(this.handler);

    const accessLogs = new logs.LogGroup(this, 'AccessLogs', { retention, removalPolicy: cdk.RemovalPolicy.DESTROY });

    this.api = new apigw.HttpApi(this, 'Api', {
      apiName: resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'api' }),
      description: `Orders API (${tier.name})`,
      createDefaultStage: false, // we want access logging + throttling on the stage, so we create it explicitly
    });
    const integration = new HttpLambdaIntegration('Lambda', this.handler);
    const iam = new HttpIamAuthorizer();
    [this.healthRoute] = this.api.addRoutes({ path: '/health', methods: [apigw.HttpMethod.GET], integration, authorizer: new apigw.HttpNoneAuthorizer() });
    this.api.addRoutes({ path: '/orders', methods: [apigw.HttpMethod.POST], integration, authorizer: iam });
    this.api.addRoutes({ path: '/orders/{id}', methods: [apigw.HttpMethod.GET], integration, authorizer: iam });

    const stage = new apigw.HttpStage(this, 'Stage', {
      httpApi: this.api,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: tier.highlyAvailable ? 1000 : 50, burstLimit: tier.highlyAvailable ? 2000 : 100 },
      detailedMetricsEnabled: true, // per-route metrics: worth the tiny cost for the dashboard
      accessLogSettings: {
        destination: new apigw.LogGroupLogDestination(accessLogs),
        // Standard JSON fields (requestId, ip, status, latency, …) — the join key for Lambda logs is requestId.
      },
    });

    this.apiUrlOutput = new cdk.CfnOutput(this, 'ApiUrl', { value: stage.url, description: 'Base URL of the orders HTTP API' });
  }
}
