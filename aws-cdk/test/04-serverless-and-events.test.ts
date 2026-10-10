import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Capture, Match, Template } from 'aws-cdk-lib/assertions';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cxapi from 'aws-cdk-lib/cx-api';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import { addToApp, ApiStack, EventsStack, SagaStack } from '../src/modules/04-serverless-and-events';
import { handler as apiHandler } from '../src/modules/04-serverless-and-events/handlers/api';
import { handler as sagaHandler } from '../src/modules/04-serverless-and-events/handlers/saga';
import { handler as workerHandler } from '../src/modules/04-serverless-and-events/handlers/worker';
import { ReadOnlyHandler } from '../src/modules/04-serverless-and-events/solutions/exercise-1-read-only-handler';
import { FifoPipeline } from '../src/modules/04-serverless-and-events/solutions/exercise-2-fifo-pipeline';
import { BulkImport } from '../src/modules/04-serverless-and-events/solutions/exercise-3-bulk-import-express';

// The handlers import '@aws-sdk/*' which is not installed in this repo (the Lambda runtime
// provides it). Mock the two modules so the pure handler logic can be unit-tested here.
const sent: unknown[] = [];
jest.mock(
  '@aws-sdk/client-dynamodb',
  () => ({ DynamoDBClient: class {} }),
  { virtual: true },
);
jest.mock(
  '@aws-sdk/lib-dynamodb',
  () => {
    class Cmd { constructor(public readonly input: unknown) {} }
    return {
      DynamoDBDocumentClient: { from: () => ({ send: async (cmd: Cmd) => { sent.push(cmd); return { Item: (cmd as { input: { Key?: { pk: string } } }).input.Key?.pk === 'ORDER#known' ? { orderId: 'known' } : undefined, Items: [], Count: 0 }; } }) },
      PutCommand: Cmd, GetCommand: Cmd, QueryCommand: Cmd, UpdateCommand: Cmd,
    };
  },
  { virtual: true },
);

afterAll(cxapi.CloudAssembly.cleanupTemporaryDirectories);

const dev = ENVIRONMENTS.dev;
const prod = ENVIRONMENTS.prod;
const WEAK = { '@aws-cdk/core:defaultCrossStackReferences': 'weak' };

// Bundling with esbuild happens once per NodejsFunction at construction; share stacks across tests.
const app = new cdk.App({ context: WEAK });
const api = new ApiStack(app, 'M04-Api', { tier: dev });
const eventsStack = new EventsStack(app, 'M04-Events', { tier: dev, table: api.table });
const saga = new SagaStack(app, 'M04-Saga', { tier: dev, table: api.table });
const apiT = Template.fromStack(api);
const eventsT = Template.fromStack(eventsStack);
const sagaT = Template.fromStack(saga);

describe('04 · ApiStack: HTTP API -> Lambda -> DynamoDB', () => {
  test('TableV2 renders a GlobalTable with a GSI, TTL and tier-driven PITR/removal', () => {
    apiT.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'gsi1', Projection: { ProjectionType: 'ALL' } })],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false } })],
    });
    apiT.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Delete' });
  });

  test('NodejsFunction is bundled by esbuild locally: the asset contains one minified index.js', () => {
    const asset = api.handler.node.findChild('Code') as cdk.aws_s3_assets.Asset;
    const assetDir = path.join(app.outdir, asset.assetPath); // assetPath is relative to the assembly directory
    expect(fs.readdirSync(assetDir)).toEqual(['index.js']);
    const js = fs.readFileSync(path.join(assetDir, 'index.js'), 'utf8');
    expect(js.split('\n').length).toBeLessThan(5); // minified
    expect(js).toContain('require("@aws-sdk/lib-dynamodb")'); // external, resolved by the runtime
    expect(js).not.toContain('sourceMappingURL');
  });

  test('function config: runtime, arm64, JSON logs, owned log group with retention', () => {
    apiT.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
      MemorySize: 512,
      LoggingConfig: { LogFormat: 'JSON', ApplicationLogLevel: 'INFO', LogGroup: { Ref: Match.stringLikeRegexp('^ApiLogs') } },
      Environment: { Variables: { TABLE_NAME: { Ref: Match.stringLikeRegexp('^Orders') } } },
    });
    apiT.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
    apiT.resourceCountIs('Custom::LogRetention', 0); // no custom resource: the log group is a real resource
  });

  test('grantReadWriteData: exactly the DynamoDB actions, scoped to the table and its indexes', () => {
    const actions = new Capture();
    apiT.hasResourceProperties('AWS::IAM::Policy', {
      Roles: [{ Ref: Match.stringLikeRegexp('^ApiHandlerServiceRole') }],
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: actions,
            Resource: [{ 'Fn::GetAtt': [Match.stringLikeRegexp('^Orders'), 'Arn'] }, { 'Fn::Join': ['', [{ 'Fn::GetAtt': [Match.stringLikeRegexp('^Orders'), 'Arn'] }, '/index/*']] }],
          }),
        ]),
      },
    });
    expect(actions.asArray()).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem']));
    expect(actions.asArray()).not.toContain('dynamodb:*');
    expect(actions.asArray()).not.toContain('dynamodb:DeleteTable');
  });

  test('alias + CodeDeploy deployment group with alarm-driven rollback (ALL_AT_ONCE in dev, canary in prod)', () => {
    apiT.hasResourceProperties('AWS::Lambda::Alias', { Name: 'live', FunctionVersion: { 'Fn::GetAtt': [Match.stringLikeRegexp('^ApiHandlerCurrentVersion'), 'Version'] } });
    apiT.hasResource('AWS::Lambda::Version', { DeletionPolicy: 'Retain' });
    apiT.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentConfigName: 'CodeDeployDefault.LambdaAllAtOnce',
      DeploymentStyle: { DeploymentType: 'BLUE_GREEN', DeploymentOption: 'WITH_TRAFFIC_CONTROL' },
      AutoRollbackConfiguration: { Enabled: true, Events: Match.arrayWith(['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_REQUEST', 'DEPLOYMENT_STOP_ON_ALARM']) },
      AlarmConfiguration: { Enabled: true, Alarms: [{ Name: { Ref: Match.stringLikeRegexp('^CanaryErrors') } }] },
    });
    const prodApi = new ApiStack(new cdk.App(), 'P', { tier: prod });
    Template.fromStack(prodApi).hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', { DeploymentConfigName: 'CodeDeployDefault.LambdaCanary10Percent5Minutes' });
    Template.fromStack(prodApi).hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain' });
  });

  test('the alarm watches Errors on the alias (not the unqualified function)', () => {
    apiT.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Dimensions: Match.arrayWith([{ Name: 'Resource', Value: { 'Fn::Join': ['', [{ Ref: Match.stringLikeRegexp('^ApiHandler') }, ':live']] } }]),
      Threshold: 1,
      TreatMissingData: 'notBreaching',
    });
  });

  test('HTTP API routes share one integration that targets the alias; stage has throttling, access logs, CORS', () => {
    apiT.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    apiT.resourceCountIs('AWS::ApiGatewayV2::Integration', 1);
    apiT.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      IntegrationType: 'AWS_PROXY',
      PayloadFormatVersion: '2.0',
      IntegrationUri: { Ref: Match.stringLikeRegexp('^Live') },
    });
    for (const key of ['POST /orders', 'GET /orders/{id}', 'GET /customers/{id}/orders']) {
      apiT.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: key });
    }
    apiT.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100, DetailedMetricsEnabled: true },
      AccessLogSettings: { DestinationArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^ApiAccessLogs'), 'Arn'] }, Format: Match.stringLikeRegexp('requestId') },
    });
    apiT.hasResourceProperties('AWS::ApiGatewayV2::Api', { CorsConfiguration: Match.objectLike({ AllowOrigins: ['https://example.com'], AllowMethods: ['GET', 'POST'] }) });
    // API Gateway may invoke the alias (and only the alias)
    apiT.hasResourceProperties('AWS::Lambda::Permission', { Action: 'lambda:InvokeFunction', Principal: 'apigateway.amazonaws.com', FunctionName: { Ref: Match.stringLikeRegexp('^Live') } });
  });
});

describe('04 · EventsStack: EventBridge -> SQS -> worker, Scheduler', () => {
  test('rule on the custom bus with a content pattern targets the queue, with EventBridge-level DLQ and retry', () => {
    eventsT.hasResourceProperties('AWS::Events::EventBus', { Name: 'cdk-mastery-dev-orders' });
    eventsT.hasResourceProperties('AWS::Events::Rule', {
      EventBusName: { Ref: Match.stringLikeRegexp('^OrdersBus') },
      EventPattern: { source: ['cdk-mastery.orders'], 'detail-type': ['OrderPlaced'], detail: { total: [{ numeric: ['>', 0] }] } },
      Targets: [
        Match.objectLike({
          Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^OrderEvents[0-9A-F]'), 'Arn'] },
          DeadLetterConfig: { Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^OrderEventsDlq'), 'Arn'] } },
          RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 },
        }),
      ],
    });
    // the queue policy lets events.amazonaws.com send, scoped to this rule
    eventsT.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'sqs:SendMessage', Principal: { Service: 'events.amazonaws.com' }, Condition: { ArnEquals: { 'aws:SourceArn': { 'Fn::GetAtt': [Match.stringLikeRegexp('^OrderPlaced'), 'Arn'] } } } })]) },
    });
  });

  test('queue -> DLQ after 3 receives; visibility timeout is 6x the function timeout', () => {
    eventsT.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 180,
      MessageRetentionPeriod: 345600,
      RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^OrderEventsDlq'), 'Arn'] }, maxReceiveCount: 3 },
      SqsManagedSseEnabled: true,
    });
    eventsT.hasResourceProperties('AWS::SQS::Queue', { MessageRetentionPeriod: 1209600 }); // the DLQ: 14 days
    eventsT.hasResourceProperties('AWS::Lambda::Function', { Timeout: 30, ReservedConcurrentExecutions: 5 });
  });

  test('event source mapping: batch of 10, 5s window, partial batch failures, bounded concurrency', () => {
    eventsT.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 10,
      MaximumBatchingWindowInSeconds: 5,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      ScalingConfig: { MaximumConcurrency: 2 },
      EventSourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^OrderEvents[0-9A-F]'), 'Arn'] },
    });
  });

  test('the worker gets write-only access to the table (cross-stack) and consume access to the queue', () => {
    const statements = new Capture();
    eventsT.hasResourceProperties('AWS::IAM::Policy', {
      Roles: [{ Ref: Match.stringLikeRegexp('^WorkerServiceRole') }],
      PolicyDocument: { Statement: statements },
    });
    const all = JSON.stringify(statements.asArray());
    expect(all).toContain('dynamodb:UpdateItem');
    expect(all).toContain('dynamodb:PutItem');
    expect(all).not.toContain('dynamodb:GetItem');
    expect(all).not.toContain('dynamodb:Query');
    expect(all).toContain('sqs:ReceiveMessage');
    expect(all).toContain('sqs:DeleteMessage');
    expect(all).toContain('Fn::GetStackOutput'); // the table ARN arrives as a weak cross-stack reference
  });

  test('alarms on DLQ depth and age of oldest message', () => {
    eventsT.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      Dimensions: [{ Name: 'QueueName', Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^OrderEventsDlq'), 'QueueName'] } }],
    });
    eventsT.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'ApproximateAgeOfOldestMessage', Threshold: 600, EvaluationPeriods: 2 });
  });

  test('EventBridge Scheduler: cron in a time zone, flexible window, input, retry and DLQ, scoped role', () => {
    eventsT.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 2 * * ? *)',
      ScheduleExpressionTimezone: 'Europe/London',
      FlexibleTimeWindow: { Mode: 'FLEXIBLE', MaximumWindowInMinutes: 15 },
      State: 'ENABLED',
      Target: Match.objectLike({
        Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Reporter'), 'Arn'] },
        Input: '{"report":"daily-orders","tier":"dev"}',
        RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 7200 },
        DeadLetterConfig: { Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^OrderEventsDlq'), 'Arn'] } },
      }),
    });
    eventsT.hasResourceProperties('AWS::IAM::Role', { AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Principal: { Service: 'scheduler.amazonaws.com' } })] } });
    eventsT.resourceCountIs('AWS::Events::Rule', 1); // the cron is NOT an events.Rule
  });
});

describe('04 · SagaStack: Step Functions', () => {
  const definition = () => {
    const sm = Object.values(sagaT.findResources('AWS::StepFunctions::StateMachine'))[0];
    const def = sm.Properties.DefinitionString;
    // DefinitionString is Fn::Join of literal fragments and refs; stitch the literals to inspect structure.
    const text = typeof def === 'string' ? def : (def['Fn::Join'][1] as unknown[]).map((p) => (typeof p === 'string' ? p : 'REF')).join('');
    return JSON.parse(text) as { StartAt: string; States: Record<string, any> };
  };

  test('definition: reserve -> charge -> choice -> record | release -> fail', () => {
    const d = definition();
    expect(d.StartAt).toBe('ReserveInventory');
    expect(d.States.ReserveInventory.Next).toBe('ChargePayment');
    expect(d.States.ChargePayment.Next).toBe('Charged?');
    expect(d.States['Charged?'].Choices[0]).toMatchObject({ Variable: '$.charge.ok', BooleanEquals: true, Next: 'RecordOrder' });
    expect(d.States['Charged?'].Default).toBe('ReleaseInventory');
    expect(d.States.RecordOrder.Next).toBe('OrderConfirmed');
    expect(d.States.ReleaseInventory.Next).toBe('PaymentDeclined');
    expect(d.States.PaymentDeclined.Type).toBe('Fail');
  });

  test('retry before catch: ServiceUnavailable retried with backoff, PaymentDeclined caught into compensation', () => {
    const d = definition();
    const charge = d.States.ChargePayment;
    expect(charge.Retry).toEqual(expect.arrayContaining([expect.objectContaining({ ErrorEquals: ['ServiceUnavailable'], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2 })]));
    expect(charge.Retry.some((r: { ErrorEquals: string[] }) => r.ErrorEquals.includes('Lambda.ServiceException'))).toBe(true);
    expect(charge.Catch).toEqual([{ ErrorEquals: ['PaymentDeclined'], ResultPath: '$.error', Next: 'ReleaseInventory' }]);
    expect(charge.ResultPath).toBe('$.charge');
    // payloadResponseOnly => the task's Resource is the function ARN itself and Parameters ARE the payload
    expect(charge.Resource).toBe('REF');
    expect(charge.Parameters).toEqual({ action: 'charge', 'orderId.$': '$.orderId', 'total.$': '$.total', 'simulate.$': '$.simulate' });
  });

  test('DynamoPutItem is an optimised integration writing a formatted key; state machine is STANDARD with logs and tracing', () => {
    const d = definition();
    expect(d.States.RecordOrder.Resource).toBe('arn:REF:states:::dynamodb:putItem');
    expect(d.States.RecordOrder.Parameters.Item.pk).toEqual({ 'S.$': "States.Format('ORDER#{}', $.orderId)" });
    expect(d.States.RecordOrder.Parameters.Item.status).toEqual({ S: 'confirmed' });
    expect(d.States.RecordOrder.ResultPath).toBeNull();
    sagaT.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineType: 'STANDARD',
      TracingConfiguration: { Enabled: true },
      LoggingConfiguration: { Level: 'ERROR', IncludeExecutionData: false },
    });
  });

  test('the state machine role gets only lambda:InvokeFunction on the steps function and dynamodb:PutItem on the table', () => {
    const statements = new Capture();
    sagaT.hasResourceProperties('AWS::IAM::Policy', {
      Roles: [{ Ref: Match.stringLikeRegexp('^OrderSagaRole') }],
      PolicyDocument: { Statement: statements },
    });
    const actions = statements.asArray().flatMap((s: { Action: string | string[] }) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions).toContain('lambda:InvokeFunction');
    expect(actions).toContain('dynamodb:PutItem');
    expect(actions.filter((a) => a.startsWith('dynamodb:'))).toEqual(['dynamodb:PutItem']);
  });
});

describe('04 · handler logic (SDK mocked)', () => {
  const base = { rawPath: '/', isBase64Encoded: false, requestContext: { requestId: 'req-1', http: { method: 'GET' } } };

  test('api: 404 for unknown order, 201 for a valid POST, 422 for a bad body', async () => {
    expect((await apiHandler({ ...base, routeKey: 'GET /orders/{id}', pathParameters: { id: 'nope' } })).statusCode).toBe(404);
    expect((await apiHandler({ ...base, routeKey: 'GET /orders/{id}', pathParameters: { id: 'known' } })).statusCode).toBe(200);
    const created = await apiHandler({ ...base, routeKey: 'POST /orders', body: JSON.stringify({ customerId: 'c1', total: 42 }) });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body!)).toMatchObject({ pk: 'ORDER#req-1', gsi1pk: 'CUSTOMER#c1', status: 'placed' });
    expect((await apiHandler({ ...base, routeKey: 'POST /orders', body: '{"total":"x"}' })).statusCode).toBe(422);
  });

  test('worker: returns only the failing message ids (partial batch failure)', async () => {
    const rec = (id: string, body: unknown) => ({ messageId: id, receiptHandle: 'h', body: typeof body === 'string' ? body : JSON.stringify(body), attributes: { ApproximateReceiveCount: '1' } });
    const out = await workerHandler({
      Records: [
        rec('ok', { 'detail-type': 'OrderPlaced', detail: { orderId: '1', customerId: 'c', total: 1, placedAt: 't' } }),
        rec('ignored', { 'detail-type': 'Other', detail: {} }),
        rec('bad', 'not json'),
      ],
    });
    expect(out).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad' }] });
  });

  test('saga steps: named errors drive Retry (ServiceUnavailable) and Catch (PaymentDeclined)', async () => {
    await expect(sagaHandler({ action: 'charge', orderId: 'o', total: 10, simulate: 'unavailable' })).rejects.toMatchObject({ name: 'ServiceUnavailable' });
    await expect(sagaHandler({ action: 'charge', orderId: 'o', total: 10, simulate: 'declined' })).rejects.toMatchObject({ name: 'PaymentDeclined' });
    await expect(sagaHandler({ action: 'reserve', orderId: 'o', total: 10 })).resolves.toMatchObject({ ok: true, reference: 'reserve-o' });
  });
});

describe('04 · exercises', () => {
  test('exercise 1: the read-only handler cannot write', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    const table = new dynamodb.TableV2(stack, 'T', { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING } });
    const httpApi = new apigwv2.HttpApi(stack, 'Api');
    const ro = new ReadOnlyHandler(stack, 'ReadOnly', { tier: dev, table, api: httpApi });
    const t = Template.fromStack(stack);
    const actions = new Capture();
    t.hasResourceProperties('AWS::IAM::Policy', {
      Roles: [{ Ref: stack.getLogicalId(ro.fn.role!.node.defaultChild as cdk.CfnResource) }],
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: actions, Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^T'), 'Arn'] } })]) },
    });
    expect(actions.asArray()).toContain('dynamodb:GetItem');
    expect(actions.asArray()).toContain('dynamodb:Query');
    expect(actions.asArray().some((a: string) => ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'].includes(a))).toBe(false);
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'GET /read/orders/{id}' });
  });

  test('exercise 2: FIFO queue + FIFO DLQ, message group id on the rule target, no batching window', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    const bus = new events.EventBus(stack, 'Bus');
    const worker = new lambda.Function(stack, 'W', { runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler = async () => ({ batchItemFailures: [] });') });
    new FifoPipeline(stack, 'Fifo', { bus, worker, messageGroupId: 'customer' });
    const t = Template.fromStack(stack);
    t.resourcePropertiesCountIs('AWS::SQS::Queue', { FifoQueue: true }, 2);
    t.hasResourceProperties('AWS::SQS::Queue', { FifoQueue: true, ContentBasedDeduplication: true, DeduplicationScope: 'messageGroup', FifoThroughputLimit: 'perMessageGroupId', RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }) });
    t.hasResourceProperties('AWS::Events::Rule', { Targets: [Match.objectLike({ SqsParameters: { MessageGroupId: 'customer' } })] });
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', { BatchSize: 10, FunctionResponseTypes: ['ReportBatchItemFailures'], MaximumBatchingWindowInSeconds: Match.absent() });
  });

  test('exercise 3: Express workflow with a bounded Map publishing to the bus', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    const bus = new events.EventBus(stack, 'Bus');
    const logGroup = new logs.LogGroup(stack, 'Logs');
    const bulk = new BulkImport(stack, 'Bulk', { bus, logGroup, maxConcurrency: 8 });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::StepFunctions::StateMachine', { StateMachineType: 'EXPRESS', LoggingConfiguration: Match.objectLike({ Level: 'ALL' }) });
    const def = Object.values(t.findResources('AWS::StepFunctions::StateMachine'))[0].Properties.DefinitionString;
    const text = (def['Fn::Join'][1] as unknown[]).map((p) => (typeof p === 'string' ? p : 'REF')).join('');
    const d = JSON.parse(text);
    expect(d.States.ForEachOrder).toMatchObject({ Type: 'Map', ItemsPath: '$.orders', MaxConcurrency: 8 });
    expect(d.States.ForEachOrder.ItemProcessor.StartAt).toBe('Normalise');
    expect(d.States.ForEachOrder.ItemProcessor.States.PublishOrderPlaced.Parameters.Entries[0]).toMatchObject({ DetailType: 'OrderPlaced', Source: 'cdk-mastery.orders' });
    t.hasResourceProperties('AWS::IAM::Policy', {
      Roles: [{ Ref: stack.getLogicalId(bulk.stateMachine.role.node.defaultChild as cdk.CfnResource) }],
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'events:PutEvents', Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Bus'), 'Arn'] } })]) },
    });
  });
});

describe('04 · addToApp', () => {
  test('three env-agnostic stacks; Events and Saga depend on Api', () => {
    const a = new cdk.App({ context: WEAK });
    addToApp(a);
    const stacks = a.node.children.filter((c): c is cdk.Stack => cdk.Stack.isStack(c));
    const byName = Object.fromEntries(stacks.map((s) => [s.stackName, s]));
    expect(Object.keys(byName).sort()).toEqual(['M04-Api', 'M04-Events', 'M04-Saga']);
    for (const s of stacks) expect(cdk.Token.isUnresolved(s.region)).toBe(true);
    Template.fromStack(byName['M04-Events']);
    Template.fromStack(byName['M04-Saga']);
    expect(byName['M04-Events'].dependencies).toContain(byName['M04-Api']);
    expect(byName['M04-Saga'].dependencies).toContain(byName['M04-Api']);
  });
});
