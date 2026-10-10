import { TerraformOutput, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { SqlDatabaseInstance } from '@cdktf/provider-google/lib/sql-database-instance';
import { SqlDatabase } from '@cdktf/provider-google/lib/sql-database';
import { SqlUser } from '@cdktf/provider-google/lib/sql-user';
import { SecretManagerSecret } from '@cdktf/provider-google/lib/secret-manager-secret';
import { SecretManagerSecretVersion } from '@cdktf/provider-google/lib/secret-manager-secret-version';
import { RandomProvider } from '@cdktf/provider-random/lib/provider';
import { Password } from '@cdktf/provider-random/lib/password';
import { environmentFor, EnvironmentTier, mandatoryTags, resourceName } from '@cdk-mastery/shared';
import { gcpProject } from './gcp-config';
import { NetworkStack } from './network-stack';
import { ProjectServices } from './services';

export interface CloudSqlStackProps {
  readonly tier: string;
  readonly network: NetworkStack;
  readonly project?: string;
  /** Database name created inside the instance. */
  readonly databaseName?: string;
  /** Application user name. */
  readonly userName?: string;
}

/** Machine tier by environment: shared-core in dev, dedicated cores elsewhere. */
export function sqlMachineTier(tier: EnvironmentTier): string {
  return tier.highlyAvailable ? 'db-custom-2-7680' : 'db-f1-micro';
}

/**
 * Postgres on Cloud SQL, reachable only over Private Service Access:
 *
 *   SqlDatabaseInstance    private IP, no public IPv4, regional HA in prod, backups + PITR
 *   SqlDatabase            the application database
 *   Password (random)      generated once, stored in state (!) and in Secret Manager
 *   SqlUser                the application user
 *   SecretManagerSecret    + Version: where the app reads the password from
 *
 * This stack references `network.network.id`, so it deploys after the network
 * stack (cross-stack reference, module 02). The Private Service Access
 * peering lives in that stack; being applied there first is what makes
 * `private_network` valid here — no `dependsOn` across stacks is needed or possible.
 */
export class CloudSqlStack extends TerraformStack {
  readonly instance: SqlDatabaseInstance;
  readonly database: SqlDatabase;
  readonly user: SqlUser;
  readonly passwordSecret: SecretManagerSecret;

  constructor(scope: Construct, id: string, props: CloudSqlStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    const region = props.network.region;
    new GoogleProvider(this, 'Google', { project: props.project ?? gcpProject(), region });
    new RandomProvider(this, 'Random');
    const apis = new ProjectServices(this, 'Apis', ['sqladmin.googleapis.com', 'secretmanager.googleapis.com']);
    const name = (component: string) => resourceName({ org: 'cdkm', service: 'db', env: tier.name, component });

    this.instance = new SqlDatabaseInstance(this, 'Postgres', {
      name: name('pg'),
      databaseVersion: 'POSTGRES_16',
      region,
      // Terraform-level guard: `destroy` (and any plan that would replace the
      // instance) fails while this is true. Prod keeps it; dev can be torn down.
      deletionProtection: tier.retainStatefulResources,
      dependsOn: apis.services,
      settings: {
        tier: sqlMachineTier(tier),
        edition: 'ENTERPRISE',
        // REGIONAL = synchronous standby in another zone; roughly doubles cost.
        availabilityType: tier.highlyAvailable ? 'REGIONAL' : 'ZONAL',
        diskType: 'PD_SSD',
        diskSize: 10,
        diskAutoresize: true,
        diskAutoresizeLimit: tier.highlyAvailable ? 500 : 50,
        // API-level guard, independent of Terraform state: the Cloud SQL API
        // itself refuses deletion while this is set.
        deletionProtectionEnabled: tier.retainStatefulResources,
        ipConfiguration: {
          ipv4Enabled: false, // no public IP, ever
          privateNetwork: props.network.network.id,
          // Lets Google services (e.g. BigQuery federated queries) reach the
          // private IP through the peering.
          enablePrivatePathForGoogleCloudServices: true,
          sslMode: 'ENCRYPTED_ONLY',
        },
        backupConfiguration: {
          enabled: true,
          startTime: '03:00',
          // PITR needs WAL archiving; 7 days of logs is the maximum retained.
          pointInTimeRecoveryEnabled: true,
          transactionLogRetentionDays: 7,
          backupRetentionSettings: { retainedBackups: tier.highlyAvailable ? 30 : 7, retentionUnit: 'COUNT' },
          location: tier.highlyAvailable ? 'us' : undefined,
        },
        maintenanceWindow: { day: 7, hour: 3, updateTrack: tier.highlyAvailable ? 'stable' : 'canary' },
        insightsConfig: { queryInsightsEnabled: true, recordApplicationTags: true, queryStringLength: 1024 },
        databaseFlags: [
          { name: 'log_min_duration_statement', value: '1000' },
          { name: 'cloudsql.iam_authentication', value: 'on' },
        ],
        userLabels: mandatoryTags(tier, 'db'),
      },
    });

    this.database = new SqlDatabase(this, 'AppDatabase', {
      name: props.databaseName ?? 'app',
      instance: this.instance.name,
      // ABANDON: `destroy` leaves the database inside the instance rather than
      // dropping it; the instance's own deletion protection is the real guard.
      deletionPolicy: tier.retainStatefulResources ? 'ABANDON' : 'DELETE',
    });

    // The password is generated by the random provider at apply time and lives
    // in state from then on. That is the reason the state bucket is IAM-locked
    // (module 02). Rotating = taint/replace this resource, which cascades to
    // the user and the secret version.
    const password = new Password(this, 'AppPassword', {
      length: 32,
      special: true,
      overrideSpecial: '!#$%&*()-_=+[]{}<>:?',
      minUpper: 2,
      minLower: 2,
      minNumeric: 2,
      minSpecial: 2,
    });

    this.user = new SqlUser(this, 'AppUser', {
      name: props.userName ?? 'app',
      instance: this.instance.name,
      password: password.result,
      deletionPolicy: tier.retainStatefulResources ? 'ABANDON' : undefined,
    });

    this.passwordSecret = new SecretManagerSecret(this, 'PasswordSecret', {
      secretId: name('pg-app-password'),
      replication: { auto: {} },
      labels: mandatoryTags(tier, 'db'),
      dependsOn: apis.services,
    });
    new SecretManagerSecretVersion(this, 'PasswordSecretVersion', {
      secret: this.passwordSecret.id,
      secretData: password.result,
    });

    new TerraformOutput(this, 'instance_connection_name', { value: this.instance.connectionName });
    new TerraformOutput(this, 'private_ip', { value: this.instance.privateIpAddress });
    new TerraformOutput(this, 'password_secret_id', { value: this.passwordSecret.secretId });
    new TerraformOutput(this, 'database_name', { value: this.database.name });
  }
}
