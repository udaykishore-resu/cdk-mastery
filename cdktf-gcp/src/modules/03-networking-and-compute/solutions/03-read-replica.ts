/**
 * Exercise 3 — a read replica, only where the tier pays for HA.
 *
 * A Cloud SQL read replica is another `google_sql_database_instance` with
 * `master_instance_name` set. Rules the API enforces and the code should too:
 *   - the primary must have backups enabled (ours does; PITR requires it anyway);
 *   - a replica cannot have its own backup configuration;
 *   - a replica of a private-IP primary must also be private-IP on the same VPC;
 *   - `deletion_protection` applies independently.
 * Cross-region replicas are the DR story: `region` differs from the primary.
 */
import { Construct } from 'constructs';
import { SqlDatabaseInstance } from '@cdktf/provider-google/lib/sql-database-instance';
import { environmentFor, mandatoryTags, resourceName } from '@cdk-mastery/shared';
import { sqlMachineTier } from '../cloud-sql-stack';

export interface ReadReplicaProps {
  readonly tier: string;
  readonly primary: SqlDatabaseInstance;
  /** Region for the replica; a different region gives you DR at the cost of replication lag. */
  readonly region: string;
  /** VPC id the primary is attached to. */
  readonly networkId: string;
}

/** Returns the replica, or `undefined` when the tier is not highly available (nothing is created). */
export function addReadReplica(scope: Construct, id: string, props: ReadReplicaProps): SqlDatabaseInstance | undefined {
  const tier = environmentFor(props.tier);
  if (!tier.highlyAvailable) return undefined;

  return new SqlDatabaseInstance(scope, id, {
    name: resourceName({ org: 'cdkm', service: 'db', env: tier.name, component: 'pg-replica', region: props.region }),
    databaseVersion: 'POSTGRES_16',
    region: props.region,
    masterInstanceName: props.primary.name,
    deletionProtection: tier.retainStatefulResources,
    settings: {
      tier: sqlMachineTier(tier),
      edition: 'ENTERPRISE',
      availabilityType: 'ZONAL', // replicas are typically zonal; HA replicas cost double again
      diskType: 'PD_SSD',
      diskAutoresize: true,
      ipConfiguration: { ipv4Enabled: false, privateNetwork: props.networkId, sslMode: 'ENCRYPTED_ONLY' },
      insightsConfig: { queryInsightsEnabled: true },
      userLabels: { ...mandatoryTags(tier, 'db'), role: 'read-replica' },
    },
  });
}
