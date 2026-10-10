import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { EnvironmentTier, resourceName } from '@cdk-mastery/shared';
import { Construct } from 'constructs';
import { ORG, SERVICE, removalPolicyFor, sizingFor } from '../config';

export interface DataStackProps extends cdk.StackProps {
  readonly tier: EnvironmentTier;
}

/**
 * Everything stateful lives here and nowhere else. The stack is deployed first,
 * changes rarely, and is the only one whose RemovalPolicy is a business decision
 * (`tier.retainStatefulResources`). Keeping compute out of it means an API
 * rollback can never take the table with it.
 *
 * Single-table design: pk/sk plus one GSI for "orders by customer". Billing is
 * on-demand in every tier — provisioned capacity is a tuning step you take with
 * real traffic numbers, not a default.
 */
export class DataStack extends cdk.Stack {
  readonly key: kms.Key;
  readonly table: dynamodb.TableV2;
  /** Deterministic, so consumers can reference the table by name instead of by export. */
  readonly tableName: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { tier } = props;
    const sizing = sizingFor(tier);
    const removalPolicy = removalPolicyFor(tier);
    this.tableName = resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'orders' });

    this.key = new kms.Key(this, 'DataKey', {
      alias: `alias/${resourceName({ org: ORG, service: SERVICE, env: tier.name, component: 'data' })}`,
      description: `Orders ${tier.name}: DynamoDB + SNS encryption key`,
      enableKeyRotation: true, // AwsSolutions-KMS5 and just good hygiene; rotation is free
      pendingWindow: cdk.Duration.days(tier.retainStatefulResources ? 30 : 7),
      removalPolicy,
    });

    this.table = new dynamodb.TableV2(this, 'Orders', {
      tableName: this.tableName,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(this.key),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: sizing.pointInTimeRecovery },
      deletionProtection: sizing.deletionProtection,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy,
      globalSecondaryIndexes: [
        {
          indexName: 'ByCustomer',
          partitionKey: { name: 'customerId', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
      ],
    });

    new cdk.CfnOutput(this, 'TableName', { value: this.table.tableName });
  }
}
