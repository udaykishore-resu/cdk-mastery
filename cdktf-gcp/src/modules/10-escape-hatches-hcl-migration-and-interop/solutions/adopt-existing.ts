import { TerraformResource } from 'cdktf';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { PubsubTopic } from '@cdktf/provider-google/lib/pubsub-topic';
import { SqlDatabaseInstance } from '@cdktf/provider-google/lib/sql-database-instance';
import { ComputeNetwork } from '@cdktf/provider-google/lib/compute-network';
import { SecretManagerSecret } from '@cdktf/provider-google/lib/secret-manager-secret';

/**
 * Exercise 1 (easy): `importFrom` needs the provider's import id format, which
 * differs per resource type and is documented at the bottom of each resource's
 * registry page. Collecting the common ones in one typed helper turns "read the
 * docs, guess, fail, retry" into a compile error.
 */
export interface ImportIdContext {
  readonly project: string;
  readonly region?: string;
}

export function importId(resource: TerraformResource, name: string, ctx: ImportIdContext): string {
  if (resource instanceof StorageBucket) return `projects/${ctx.project}/buckets/${name}`; // or just the bucket name
  if (resource instanceof ServiceAccount) return `projects/${ctx.project}/serviceAccounts/${name}`; // name = email
  if (resource instanceof PubsubTopic) return `projects/${ctx.project}/topics/${name}`;
  if (resource instanceof SqlDatabaseInstance) return `projects/${ctx.project}/instances/${name}`;
  if (resource instanceof ComputeNetwork) return `projects/${ctx.project}/global/networks/${name}`;
  if (resource instanceof SecretManagerSecret) return `projects/${ctx.project}/secrets/${name}`;
  throw new Error(`importId: no known id format for ${resource.terraformResourceType}; check the registry docs "Import" section`);
}

/** Adopt an existing object into this resource's state on the next apply. */
export function adopt<T extends TerraformResource>(resource: T, name: string, ctx: ImportIdContext): T {
  resource.importFrom(importId(resource, name, ctx));
  return resource;
}
