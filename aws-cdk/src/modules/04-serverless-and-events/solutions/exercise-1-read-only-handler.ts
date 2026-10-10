import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvironmentTier } from '@cdk-mastery/shared';
import { bundlingFor, logRetentionFor } from '../api-stack';

/**
 * Exercise 1 — split reads from writes so the read path cannot write.
 *
 * One function per privilege level is the cheapest form of least privilege there is:
 * `grantReadData` on the read handler produces GetItem/Query/Scan/BatchGet (no PutItem),
 * and a bug or a compromised dependency in the read path cannot mutate the table. The
 * handler code is the same file; only the routes and the grant differ.
 */
export interface ReadOnlyHandlerProps {
  readonly tier: EnvironmentTier;
  readonly table: dynamodb.ITableV2;
  readonly api: apigwv2.HttpApi;
}

export class ReadOnlyHandler extends Construct {
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: ReadOnlyHandlerProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, 'Fn', {
      entry: path.join(__dirname, '..', 'handlers', 'api.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      logGroup: new logs.LogGroup(this, 'Logs', { retention: logRetentionFor(props.tier), removalPolicy: cdk.RemovalPolicy.DESTROY }),
      environment: { TABLE_NAME: props.table.tableName },
      bundling: bundlingFor(props.tier),
    });
    props.table.grantReadData(this.fn);

    const integration = new HttpLambdaIntegration('ReadIntegration', this.fn);
    props.api.addRoutes({ path: '/read/orders/{id}', methods: [apigwv2.HttpMethod.GET], integration });
    props.api.addRoutes({ path: '/read/customers/{id}/orders', methods: [apigwv2.HttpMethod.GET], integration });
  }
}
