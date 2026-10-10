import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvironmentTier } from '@cdk-mastery/shared';

/**
 * HTTP API → Lambda (esbuild-bundled TypeScript) → DynamoDB, with a canary-deployed alias.
 *
 * Data path:  client → HttpApi (routes) → HttpLambdaIntegration → Alias "live" → $LATEST-or-
 *             previous version (CodeDeploy shifts weights) → TableV2 (+ GSI for queries).
 *
 * Least privilege is expressed with `grant*`: `table.grantReadWriteData(fn)` writes exactly
 * the DynamoDB actions the L2 knows this construct needs, scoped to the table ARN and its
 * indexes, onto the function's role. Nothing else is granted. (`grantReadData` would be
 * the choice for a read-only function; the split is the point.)
 */
export interface ApiStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
}

export function bundlingFor(tier: EnvironmentTier) {
  return {
    minify: true,
    sourceMap: false, // keep assets small and tests fast; enable sourceMap + NODE_OPTIONS=--enable-source-maps when debugging
    target: 'node22',
    format: OutputFormat.CJS,
    // `@aws-sdk/*` is external by default for pinned runtimes: the runtime provides it.
    define: { 'process.env.TIER': JSON.stringify(tier.name) },
  };
}

export function logRetentionFor(tier: EnvironmentTier): logs.RetentionDays {
  return ({ 7: logs.RetentionDays.ONE_WEEK, 30: logs.RetentionDays.ONE_MONTH, 365: logs.RetentionDays.ONE_YEAR } as Record<number, logs.RetentionDays>)[tier.logRetentionDays] ?? logs.RetentionDays.ONE_MONTH;
}

export class ApiStack extends cdk.Stack {
  readonly table: dynamodb.TableV2;
  readonly handler: NodejsFunction;
  readonly alias: lambda.Alias;
  readonly api: apigwv2.HttpApi;
  readonly stage: apigwv2.HttpStage;
  readonly deploymentGroup: codedeploy.LambdaDeploymentGroup;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const retain = props.tier.retainStatefulResources;

    // --- Table --------------------------------------------------------------------------
    // TableV2 renders AWS::DynamoDB::GlobalTable (even with one replica), which is the
    // resource type that supports on-demand billing + replicas + per-index settings cleanly.
    this.table = new dynamodb.TableV2(this, 'Orders', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      globalSecondaryIndexes: [
        {
          indexName: 'gsi1',
          partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
      ],
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: retain },
      removalPolicy: retain ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // --- Function -----------------------------------------------------------------------
    // Own the log group: retention, removal and (in prod) KMS are yours. Without `logGroup`
    // the runtime creates `/aws/lambda/<name>` with infinite retention on first invoke
    // (or, with the `useCdkManagedLogGroup` flag, CDK creates one with no retention set).
    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      retention: logRetentionFor(props.tier),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.handler = new NodejsFunction(this, 'ApiHandler', {
      entry: path.join(__dirname, 'handlers', 'api.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(10),
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      environment: {
        TABLE_NAME: this.table.tableName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: bundlingFor(props.tier),
      // Snapshot every deploy as a numbered version so the alias can shift between two of them.
      currentVersionOptions: { removalPolicy: cdk.RemovalPolicy.RETAIN },
    });
    this.table.grantReadWriteData(this.handler);

    // --- Alias + canary -----------------------------------------------------------------
    // `currentVersion` publishes a Version whose logical ID includes the code hash, so a
    // code change = new Version resource. The alias moves; the API integration points at
    // the alias and never changes.
    this.alias = new lambda.Alias(this, 'Live', {
      aliasName: 'live',
      version: this.handler.currentVersion,
    });

    const errors = this.alias.metricErrors({ period: cdk.Duration.minutes(1), statistic: 'sum' });
    const errorAlarm = new cloudwatch.Alarm(this, 'CanaryErrors', {
      metric: errors,
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Any invocation error on the live alias during a deployment rolls it back',
    });

    this.deploymentGroup = new codedeploy.LambdaDeploymentGroup(this, 'Canary', {
      alias: this.alias,
      // 10% of traffic to the new version for 5 minutes, then 100%. LINEAR_* and ALL_AT_ONCE
      // are the alternatives; dev could use ALL_AT_ONCE to save the 5 minutes.
      deploymentConfig: props.tier.requiresApproval
        ? codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES
        : codedeploy.LambdaDeploymentConfig.ALL_AT_ONCE,
      alarms: [errorAlarm],
      autoRollback: { failedDeployment: true, stoppedDeployment: true, deploymentInAlarm: true },
    });

    // --- HTTP API -----------------------------------------------------------------------
    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logRetentionFor(props.tier),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.api = new apigwv2.HttpApi(this, 'OrdersApi', {
      description: `cdk-mastery orders API (${props.tier.name})`,
      // The implicit $default stage has no throttling and no access logs; create it explicitly.
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: ['https://example.com'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
        maxAge: cdk.Duration.hours(1),
      },
    });
    this.stage = new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: this.api,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: props.tier.highlyAvailable ? 1000 : 50, burstLimit: props.tier.highlyAvailable ? 2000 : 100 },
      detailedMetricsEnabled: true,
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(accessLogs),
        format: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
    });

    // One integration bound to the alias; several routes share it. HTTP API v2 payload
    // format 2.0 gives the handler `routeKey` to dispatch on.
    const integration = new HttpLambdaIntegration('OrdersIntegration', this.alias);
    this.api.addRoutes({ path: '/orders', methods: [apigwv2.HttpMethod.POST], integration });
    this.api.addRoutes({ path: '/orders/{id}', methods: [apigwv2.HttpMethod.GET], integration });
    this.api.addRoutes({ path: '/customers/{id}/orders', methods: [apigwv2.HttpMethod.GET], integration });

    new cdk.CfnOutput(this, 'ApiUrl', { value: this.stage.url });
  }
}
