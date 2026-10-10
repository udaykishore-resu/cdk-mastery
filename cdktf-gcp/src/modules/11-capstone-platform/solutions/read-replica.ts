import { Construct } from 'constructs';
import { SqlDatabaseInstance } from '@cdktf/provider-google/lib/sql-database-instance';
import { EnvironmentTier } from '@cdk-mastery/shared';

export interface ReadReplicaProps {
  readonly tier: EnvironmentTier;
  readonly primary: SqlDatabaseInstance;
  /** Region for the replica; a different region gives DR, the same region gives read scaling only. */
  readonly region: string;
  readonly networkId: string;
  readonly encryptionKeyName?: string;
  readonly labels?: Record<string, string>;
}

/**
 * Exercise 3 (hard): a cross-region read replica, prod only.
 *
 * What makes it hard is not the resource, it is the constraints the API
 * imposes that only show up at apply:
 *   - the primary must have `backup_configuration.enabled` and, for Postgres,
 *     point-in-time recovery (WAL archiving) on — the data stack does this in prod;
 *   - a cross-region replica of a private-IP primary needs the *same* VPC to be
 *     peered in the replica region (PSA is global, so it is) and CMEK in the
 *     replica's region: a key from another region is rejected. `encryptionKeyName`
 *     therefore must be a key ring in `props.region`, not the primary's;
 *   - `deletion_protection` on the replica blocks `destroy` of the primary too;
 *   - replicas cannot be promoted by Terraform; promotion is an API call and a
 *     subsequent `import`/`moved` of the promoted instance (module 10).
 *
 * Returns undefined for non-prod tiers so the caller can write
 * `const replica = addReadReplica(...)` without a tier check of its own.
 */
export function addReadReplica(scope: Construct, id: string, props: ReadReplicaProps): SqlDatabaseInstance | undefined {
  if (!props.tier.highlyAvailable) return undefined;
  if (props.primary.regionInput === props.region) {
    throw new Error(`read replica region must differ from the primary's (${props.region}) to provide DR`);
  }
  return new SqlDatabaseInstance(scope, id, {
    name: `${props.primary.nameInput}-replica-${props.region}`,
    region: props.region,
    databaseVersion: props.primary.databaseVersionInput ?? 'POSTGRES_16',
    masterInstanceName: props.primary.name,
    encryptionKeyName: props.encryptionKeyName,
    deletionProtection: props.tier.retainStatefulResources,
    replicaConfiguration: { failoverTarget: false },
    settings: {
      tier: 'db-custom-2-7680',
      availabilityType: 'ZONAL', // replicas are zonal; HA of the replica is a second replica
      diskAutoresize: true,
      userLabels: props.labels,
      ipConfiguration: { ipv4Enabled: false, privateNetwork: props.networkId },
    },
  });
}
