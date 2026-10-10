import { TerraformOutput } from 'cdktf';
import { Construct } from 'constructs';
import { RandomProvider } from '@cdktf/provider-random/lib/provider';
import { Password } from '@cdktf/provider-random/lib/password';
import { BigqueryDataset } from '@cdktf/provider-google/lib/bigquery-dataset';
import { SecretManagerSecret } from '@cdktf/provider-google/lib/secret-manager-secret';
import { SecretManagerSecretVersion } from '@cdktf/provider-google/lib/secret-manager-secret-version';
import { SqlDatabase } from '@cdktf/provider-google/lib/sql-database';
import { SqlDatabaseInstance } from '@cdktf/provider-google/lib/sql-database-instance';
import { SqlUser } from '@cdktf/provider-google/lib/sql-user';
import { PlatformContext, PlatformStack } from '../platform-stack';
import { FoundationStack } from './foundation-stack';
import { NetworkStack } from './network-stack';

export interface DataStackProps {
  readonly ctx: PlatformContext;
  readonly foundation: FoundationStack;
  readonly network: NetworkStack;
}

/**
 * `m11-<env>-data`: private Cloud SQL Postgres, its application database and
 * user, the user's password in Secret Manager, and the analytics dataset.
 *
 * Tier decides: HA (REGIONAL) and PITR in prod; deletion protection on both the
 * Terraform side and the API side from `retainStatefulResources`; CMEK in prod
 * (the RequireCmekAspect in prod would refuse to synthesize without it).
 */
export class DataStack extends PlatformStack {
  readonly instance: SqlDatabaseInstance;
  readonly database: SqlDatabase;
  readonly dbUser: SqlUser;
  readonly dbPasswordSecret: SecretManagerSecret;
  readonly dataset: BigqueryDataset;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props.ctx);
    const { tier, region } = this.ctx;
    const prod = tier.name === 'prod';
    new RandomProvider(this, 'Random');

    this.instance = new SqlDatabaseInstance(this, 'Postgres', {
      name: this.name('pg'),
      databaseVersion: 'POSTGRES_16',
      region,
      // prod: CMEK from the foundation stack (cross-stack reference); dev: Google-managed.
      encryptionKeyName: prod ? props.foundation.key.id : undefined,
      deletionProtection: tier.retainStatefulResources,
      settings: {
        tier: tier.highlyAvailable ? 'db-custom-2-7680' : 'db-f1-micro',
        edition: tier.highlyAvailable ? 'ENTERPRISE' : 'ENTERPRISE',
        availabilityType: tier.highlyAvailable ? 'REGIONAL' : 'ZONAL',
        diskAutoresize: true,
        diskType: 'PD_SSD',
        deletionProtectionEnabled: tier.retainStatefulResources,
        userLabels: this.labels, // Cloud SQL calls them user_labels; the LabelsAspect cannot see this field
        ipConfiguration: {
          ipv4Enabled: false, // private IP only
          privateNetwork: props.network.network.id, // cross-stack: network deploys first, PSA included
          enablePrivatePathForGoogleCloudServices: true,
          sslMode: 'ENCRYPTED_ONLY',
        },
        backupConfiguration: {
          enabled: true,
          pointInTimeRecoveryEnabled: prod,
          startTime: '03:00',
          transactionLogRetentionDays: prod ? 7 : 1,
          backupRetentionSettings: { retainedBackups: prod ? 30 : 7 },
        },
        maintenanceWindow: { day: 7, hour: 3, updateTrack: prod ? 'stable' : 'canary' },
        insightsConfig: { queryInsightsEnabled: true, recordApplicationTags: true },
      },
    });

    this.database = new SqlDatabase(this, 'OrdersDb', { name: 'orders', instance: this.instance.name });

    // The password never appears in code; it does appear in state (twice: the
    // random resource and the sql user). State is in GCS with CMEK on the bucket
    // and objectAdmin limited to the deployer — see module 08.
    const password = new Password(this, 'DbPassword', { length: 32, special: false });
    this.dbUser = new SqlUser(this, 'AppUser', {
      name: 'orders_app',
      instance: this.instance.name,
      password: password.result,
      deletionPolicy: 'ABANDON', // dropping the user while connections exist fails; abandon and let the instance deletion clean up
    });

    this.dbPasswordSecret = new SecretManagerSecret(this, 'DbPasswordSecret', {
      secretId: this.name('db-password'),
      replication: { auto: {} },
      labels: this.labels,
      deletionProtection: tier.retainStatefulResources,
    });
    new SecretManagerSecretVersion(this, 'DbPasswordVersion', {
      secret: this.dbPasswordSecret.id,
      secretData: password.result,
      deletionPolicy: tier.retainStatefulResources ? 'DISABLE' : 'DELETE',
    });

    this.dataset = new BigqueryDataset(this, 'Analytics', {
      datasetId: `${this.name('analytics').replace(/-/g, '_')}`,
      location: region.toUpperCase(),
      labels: this.labels,
      deleteContentsOnDestroy: !tier.retainStatefulResources,
      defaultTableExpirationMs: prod ? undefined : 30 * 24 * 3600 * 1000,
      defaultEncryptionConfiguration: prod ? { kmsKeyName: props.foundation.key.id } : undefined,
    });

    new TerraformOutput(this, 'InstanceConnectionName', { value: this.instance.connectionName });
    new TerraformOutput(this, 'InstancePrivateIp', { value: this.instance.privateIpAddress, sensitive: true });
    new TerraformOutput(this, 'DbPasswordSecretId', { value: this.dbPasswordSecret.secretId });
  }
}
