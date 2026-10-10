import * as cdk from 'aws-cdk-lib';
import { Annotations, Capture, Match, Template } from 'aws-cdk-lib/assertions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import { addToApp, ConstructsDemoStack, IQueueWorker, QueueWorker, SecureBucket, SecureBucketEncryption, ServiceDashboard } from '../src/modules/05-custom-constructs';
import { notifyOnAlarm } from '../src/modules/05-custom-constructs/solutions/exercise-1-alarm-actions';
import { fromSecureBucketAttributes } from '../src/modules/05-custom-constructs/solutions/exercise-2-import-secure-bucket';
import { Notifier, NotifierEncryption, QueueTarget, TopicTarget } from '../src/modules/05-custom-constructs/solutions/exercise-3-jsii-compatible-api';

const LOGS_VIA_POLICY = { '@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy': true };
const inlineCode = () => lambda.Code.fromInline('exports.handler = async () => ({ batchItemFailures: [] });');
const stackWithFlags = (id = 'S') => new cdk.Stack(new cdk.App({ context: LOGS_VIA_POLICY }), id);

describe('05 · SecureBucket', () => {
  test('defaults: KMS key with rotation, versioning, block public, TLS-only, access logs, lifecycle, RETAIN', () => {
    const stack = stackWithFlags();
    const sb = new SecureBucket(stack, 'Docs');
    const t = Template.fromStack(stack);

    expect(sb.encryption).toBe(SecureBucketEncryption.KMS);
    expect(sb.encryptionKey).toBeDefined();
    expect(sb.node.defaultChild).toBe(sb.bucket);
    t.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    t.resourceCountIs('AWS::S3::Bucket', 2); // the bucket + its access-log bucket
    t.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ BucketKeyEnabled: true, ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: { 'Fn::GetAtt': [Match.stringLikeRegexp('^DocsKey'), 'Arn'] } } }] },
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      LoggingConfiguration: { DestinationBucketName: { Ref: Match.stringLikeRegexp('^DocsAccessLogs') }, LogFilePrefix: 'Docs/' },
      LifecycleConfiguration: {
        Rules: [Match.objectLike({ Id: 'housekeeping', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }, NoncurrentVersionExpiration: { NoncurrentDays: 90 } })],
      },
    });
    // enforceSSL + minimumTLSVersion => two Deny statements on the bucket policy
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
          Match.objectLike({ Effect: 'Deny', Condition: { NumericLessThan: { 's3:TlsVersion': 1.2 } } }),
        ]),
      },
    });
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    Annotations.fromStack(stack).hasNoWarning('/S/Docs', Match.anyValue());
  });

  test('S3-managed encryption warns with a stable id; DESTROY + versioned warns from the validation', () => {
    const stack = stackWithFlags();
    new SecureBucket(stack, 'Cheap', { encryption: SecureBucketEncryption.S3_MANAGED, removalPolicy: cdk.RemovalPolicy.DESTROY });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::KMS::Key', 0);
    t.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
    Annotations.fromStack(stack).hasWarning('/S/Cheap', Match.stringLikeRegexp('S3-managed encryption.*\\[ack: cdk-mastery:SecureBucket.s3ManagedEncryption\\]'));
    Annotations.fromStack(stack).hasWarning('/S/Cheap', Match.stringLikeRegexp('RemovalPolicy.DESTROY with versioning'));
  });

  test('constructor-time validation throws; synth-time validation fails synth with the path', () => {
    const stack = stackWithFlags();
    expect(() => new SecureBucket(stack, 'BadPrefix', { accessLogsPrefix: 'logs' })).toThrow(/accessLogsPrefix must end with "\/"/);
    expect(() => new SecureBucket(stack, 'BadName', { bucketName: 'MixedCase' })).toThrow(/must be lowercase/);
    new SecureBucket(stack, 'BadLifecycle', { lifecycle: { transitionAfter: cdk.Duration.days(90), expireNoncurrentAfter: cdk.Duration.days(30) } });
    expect(() => Template.fromStack(stack)).toThrow(/\[S\/BadLifecycle\] expireNoncurrentAfter \(30d\) must be greater than transitionAfter \(90d\)/);
  });

  test('grantRead delegates to the L2 and includes kms:Decrypt on the key; metric* target AWS/S3 daily storage metrics', () => {
    const stack = stackWithFlags();
    const sb = new SecureBucket(stack, 'Docs', { lifecycle: { transitionAfter: cdk.Duration.days(30) } });
    const role = new iam.Role(stack, 'Reader', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    sb.grantRead(role);
    const t = Template.fromStack(stack);
    const statements = new Capture();
    t.hasResourceProperties('AWS::IAM::Policy', { Roles: [{ Ref: Match.stringLikeRegexp('^Reader') }], PolicyDocument: { Statement: statements } });
    const all = JSON.stringify(statements.asArray());
    expect(all).toContain('s3:GetObject*');
    expect(all).toContain('kms:Decrypt');
    expect(all).not.toContain('s3:PutObject');

    const m = sb.metricNumberOfObjects();
    expect(m.namespace).toBe('AWS/S3');
    expect(m.period.toDays()).toBe(1);
    expect(m.dimensions).toEqual({ BucketName: sb.bucket.bucketName, StorageType: 'AllStorageTypes' });
    expect(sb.metricBucketSizeBytes().dimensions).toMatchObject({ StorageType: 'StandardStorage' });
    t.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Id: 'tier-current-versions', Transitions: [{ StorageClass: 'GLACIER_IR', TransitionInDays: 30 }] })]) },
    });
  });

  test('bring-your-own key and log bucket are honoured (composition, not inheritance)', () => {
    const stack = stackWithFlags();
    const key = new kms.Key(stack, 'SharedKey');
    const shared = new SecureBucket(stack, 'Shared', { encryption: SecureBucketEncryption.S3_MANAGED, removalPolicy: cdk.RemovalPolicy.DESTROY });
    const sb = new SecureBucket(stack, 'Docs', { encryptionKey: key, accessLogsBucket: shared.bucket, accessLogsPrefix: 'docs/' });
    expect(sb.encryptionKey).toBe(key);
    expect(sb.accessLogsBucket).toBe(shared.bucket);
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::KMS::Key', 1);
    t.resourceCountIs('AWS::S3::Bucket', 3); // shared + shared's own log bucket + docs (no extra log bucket)
  });
});

describe('05 · QueueWorker', () => {
  test('SQS + DLQ + Lambda + event source + two alarms, with the visibility-timeout invariant', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    const w = new QueueWorker(stack, 'Ingest', { code: inlineCode(), timeout: cdk.Duration.seconds(20), batchSize: 5, maxReceiveCount: 4, maxConcurrency: 3 });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::SQS::Queue', 2);
    t.hasResourceProperties('AWS::SQS::Queue', { VisibilityTimeout: 120, RedrivePolicy: Match.objectLike({ maxReceiveCount: 4 }) });
    t.hasResourceProperties('AWS::SQS::Queue', { MessageRetentionPeriod: 1209600 });
    t.hasResourceProperties('AWS::Lambda::Function', { Timeout: 20, Runtime: 'nodejs22.x', Architectures: ['arm64'], LoggingConfig: Match.objectLike({ LogFormat: 'JSON' }) });
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', { BatchSize: 5, FunctionResponseTypes: ['ReportBatchItemFailures'], ScalingConfig: { MaximumConcurrency: 3 }, MaximumBatchingWindowInSeconds: Match.absent() });
    t.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'ApproximateNumberOfMessagesVisible', Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold' });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'ApproximateAgeOfOldestMessage', Threshold: 600, EvaluationPeriods: 2 });
    expect(w.alarms).toEqual([w.deadLetterAlarm, w.oldestMessageAlarm]);
    t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  test('grantSend on the real worker gives sqs:SendMessage on the work queue only', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    const w = new QueueWorker(stack, 'Ingest', { code: inlineCode() });
    const producer = new iam.Role(stack, 'Producer', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
    w.grantSend(producer);
    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
      Roles: [{ Ref: Match.stringLikeRegexp('^Producer') }],
      PolicyDocument: {
        Statement: [Match.objectLike({ Action: Match.arrayWith(['sqs:SendMessage']), Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^IngestQueue'), 'Arn'] } })],
      },
    });
  });

  test('fromQueueWorkerAttributes returns an IQueueWorker with working grant*/metric* and no owned resources', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    const imported: IQueueWorker = QueueWorker.fromQueueWorkerAttributes(stack, 'Remote', {
      queueArn: 'arn:aws:sqs:us-east-1:111111111111:remote-queue',
      deadLetterQueueArn: 'arn:aws:sqs:us-east-1:111111111111:remote-dlq',
      functionArn: 'arn:aws:lambda:us-east-1:111111111111:function:remote-worker',
    });
    const producer = new iam.Role(stack, 'Producer', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
    imported.grantSend(producer);
    expect(imported.metricDeadLetterDepth().dimensions).toEqual({ QueueName: 'remote-dlq' });
    expect(imported.metricOldestMessageAge().dimensions).toEqual({ QueueName: 'remote-queue' });
    expect(imported.handler.functionName).toBe('remote-worker');
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::SQS::Queue', 0);
    t.resourceCountIs('AWS::Lambda::Function', 0);
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: [Match.objectLike({ Action: Match.arrayWith(['sqs:SendMessage']), Resource: 'arn:aws:sqs:us-east-1:111111111111:remote-queue' })] },
    });
    expect('alarms' in imported).toBe(false);
  });

  test('validation: constructor throws on impossible props; synth-time check reads rendered L1 props', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    expect(() => new QueueWorker(stack, 'Bad', { code: inlineCode(), batchSize: 0 })).toThrow(/batchSize must be 1..10000/);
    const w = new QueueWorker(stack, 'Big', { code: inlineCode(), batchSize: 50 });
    Annotations.fromStack(stack).hasWarning('/S/Big', Match.stringLikeRegexp('batchSize 50 > 10'));
    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::EventSourceMapping', { BatchSize: 50, MaximumBatchingWindowInSeconds: 5 });

    // Someone escape-hatches the DLQ retention below the work queue's: the validation catches it.
    const stack2 = new cdk.Stack(new cdk.App(), 'S2');
    const w2 = new QueueWorker(stack2, 'W', { code: inlineCode() });
    (w2.deadLetterQueue.node.defaultChild as sqs.CfnQueue).messageRetentionPeriod = 60;
    expect(() => Template.fromStack(stack2)).toThrow(/dead-letter queue retention \(60s\) must exceed/);
    expect(w).toBeDefined();
  });
});

describe('05 · ServiceDashboard', () => {
  test('lays out a header, an alarm status widget and rows of graphs from IMetric[]', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    const w = new QueueWorker(stack, 'W', { code: inlineCode() });
    const errors = w.handler.metricErrors();
    const ratio = new cloudwatch.MathExpression({ expression: 'errors / invocations', usingMetrics: { errors, invocations: w.handler.metricInvocations() }, label: 'error ratio' });
    const d = new ServiceDashboard(stack, 'Dash', { serviceName: 'orders', metrics: [w.metricOldestMessageAge(), w.metricDeadLetterDepth(), errors, ratio], alarms: w.alarms, columns: 2 });
    d.addMetrics(w.handler.metricDuration()); // after construction, before synth: allowed
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::CloudWatch::Dashboard', { DashboardName: 'orders-service' });
    const body = JSON.parse(stack.resolve((d.dashboard.node.defaultChild as cloudwatch.CfnDashboard).dashboardBody)['Fn::Join'][1].map((p: unknown) => (typeof p === 'string' ? p : 'REF')).join(''));
    const types = body.widgets.map((wd: { type: string; properties: { title?: string } }) => [wd.type, wd.properties.title]);
    expect(types[0]).toEqual(['text', undefined]);
    expect(types[1]).toEqual(['alarm', 'Alarms']);
    expect(types.slice(2).map((x: string[]) => x[0])).toEqual(['metric', 'metric', 'metric', 'metric', 'metric']);
    expect(types.slice(2).map((x: string[]) => x[1])).toEqual(['ApproximateAgeOfOldestMessage', 'ApproximateNumberOfMessagesVisible', 'Errors', 'error ratio', 'Duration']);
    // two columns => graph widgets are 12 wide and rows wrap
    const graphs = body.widgets.filter((wd: { type: string }) => wd.type === 'metric');
    expect(graphs.every((g: { width: number }) => g.width === 12)).toBe(true);
    expect(graphs.map((g: { x: number }) => g.x)).toEqual([0, 12, 0, 12, 0]);
    expect(body.start).toBe('-PT3H');
    expect(() => d.addMetrics(errors)).toThrow(/cannot add metrics after synthesis/);
  });

  test('validation: no metrics is an error; bad serviceName/columns throw early', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    expect(() => new ServiceDashboard(stack, 'A', { serviceName: 'bad name', metrics: [] })).toThrow(/serviceName must match/);
    expect(() => new ServiceDashboard(stack, 'B', { serviceName: 'ok', metrics: [], columns: 5 })).toThrow(/columns must be 1..4/);
    new ServiceDashboard(stack, 'C', { serviceName: 'ok', metrics: [] });
    expect(() => Template.fromStack(stack)).toThrow(/\[S\/C\] at least one metric is required/);
  });
});

describe('05 · demo stack and exercises', () => {
  test('ConstructsDemoStack composes the three constructs; the worker can read the bucket and decrypt', () => {
    const app = new cdk.App({ context: LOGS_VIA_POLICY });
    const stack = new ConstructsDemoStack(app, 'M05-Constructs', { tier: ENVIRONMENTS.dev });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    t.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    t.resourceCountIs('AWS::KMS::Key', 1);
    t.hasResourceProperties('AWS::S3::Bucket', { BucketName: 'cdkm-m05-dev-documents' });
    const statements = new Capture();
    t.hasResourceProperties('AWS::IAM::Policy', { Roles: [{ Ref: Match.stringLikeRegexp('^IngestHandlerServiceRole') }], PolicyDocument: { Statement: statements } });
    const all = JSON.stringify(statements.asArray());
    expect(all).toContain('s3:GetObject*');
    expect(all).toContain('kms:Decrypt');
    expect(all).toContain('sqs:ReceiveMessage');
    // dev tier: bucket is destroyable; prod tier: retained
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    const prod = new ConstructsDemoStack(new cdk.App({ context: LOGS_VIA_POLICY }), 'P', { tier: ENVIRONMENTS.prod });
    Template.fromStack(prod).hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
  });

  test('addToApp registers M05-Constructs (env-agnostic)', () => {
    const app = new cdk.App({ context: LOGS_VIA_POLICY });
    addToApp(app);
    const stacks = app.node.children.filter((c): c is cdk.Stack => cdk.Stack.isStack(c));
    expect(stacks.map((s) => s.stackName)).toEqual(['M05-Constructs']);
    expect(cdk.Token.isUnresolved(stacks[0].region)).toBe(true);
  });

  test('exercise 1: notifyOnAlarm wires every exposed alarm to the topic', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    const w = new QueueWorker(stack, 'W', { code: inlineCode() });
    const topic = new sns.Topic(stack, 'Oncall');
    notifyOnAlarm(w, topic, { alsoOnOk: true });
    const t = Template.fromStack(stack);
    t.resourcePropertiesCountIs('AWS::CloudWatch::Alarm', { AlarmActions: [{ Ref: Match.stringLikeRegexp('^Oncall') }], OKActions: [{ Ref: Match.stringLikeRegexp('^Oncall') }] }, 2);
  });

  test('exercise 2: an imported SecureBucket grants KMS permissions only when the key ARN is known', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    const withKey = fromSecureBucketAttributes(stack, 'WithKey', { bucketArn: 'arn:aws:s3:::docs-prod', encryptionKeyArn: 'arn:aws:kms:us-east-1:111111111111:key/abc' });
    const noKey = fromSecureBucketAttributes(stack, 'NoKey', { bucketArn: 'arn:aws:s3:::logs-prod' });
    const a = new iam.Role(stack, 'A', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    const b = new iam.Role(stack, 'B', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    withKey.grantRead(a);
    noKey.grantWrite(b);
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::IAM::Policy', { Roles: [{ Ref: Match.stringLikeRegexp('^A') }], PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: Match.arrayWith(['kms:Decrypt']), Resource: 'arn:aws:kms:us-east-1:111111111111:key/abc' })]) } });
    const bStatements = new Capture();
    t.hasResourceProperties('AWS::IAM::Policy', { Roles: [{ Ref: Match.stringLikeRegexp('^B') }], PolicyDocument: { Statement: bStatements } });
    expect(JSON.stringify(bStatements.asArray())).not.toContain('kms:');
    Annotations.fromStack(stack).hasWarning('/S/NoKey', Match.stringLikeRegexp('Imported without encryptionKeyArn'));
    expect(withKey.metricNumberOfObjects().dimensions).toEqual({ BucketName: 'docs-prod', StorageType: 'AllStorageTypes' });
  });

  test('exercise 3: the jsii-compatible API — static factories, behavioural interfaces, no unions/generics', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S');
    const key = new kms.Key(stack, 'K');
    const delivered: string[] = [];
    const n = new Notifier(stack, 'N', {
      target: new TopicTarget(new sns.Topic(stack, 'T')),
      encryption: NotifierEncryption.kms(key),
      hook: { onDelivered: (id) => delivered.push(id) },
    });
    expect(n.encryption.kind).toBe('kms');
    expect(n.encryption.key).toBe(key);
    expect(NotifierEncryption.managed().kind).toBe('managed');
    expect(delivered).toEqual(['S/N']);
    const q = new Notifier(stack, 'Q', { target: new QueueTarget(new sqs.Queue(stack, 'Queue')) });
    expect(q.encryption.kind).toBe('managed');
    const outputs = Object.keys(Template.fromStack(stack).findOutputs('*'));
    expect(outputs).toEqual(expect.arrayContaining([expect.stringMatching(/^NTopicTargetArn/), expect.stringMatching(/^QQueueTargetArn/)]));
  });
});
