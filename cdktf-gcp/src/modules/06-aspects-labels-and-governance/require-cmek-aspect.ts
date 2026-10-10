import { Annotations, IAspect } from 'cdktf';
import { IConstruct } from 'constructs';
import { ComputeDisk } from '@cdktf/provider-google/lib/compute-disk';
import { SqlDatabaseInstance } from '@cdktf/provider-google/lib/sql-database-instance';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';

export interface RequireCmekAspectProps {
  /**
   * Optional allow-list of KMS key resource names
   * (`projects/p/locations/l/keyRings/r/cryptoKeys/k`). When set, a resource
   * encrypted with any other key is also an error. Leave unset to accept any CMEK.
   */
  readonly allowedKeys?: string[];
}

/**
 * Validating aspect: customer-managed encryption keys on everything that stores
 * data at rest and supports CMEK in the Google provider:
 *
 *   google_storage_bucket        -> encryption { default_kms_key_name }
 *   google_sql_database_instance -> encryption_key_name
 *   google_compute_disk          -> disk_encryption_key { kms_key_self_link }
 *
 * Google-managed encryption is on by default everywhere, so CMEK buys you key
 * *control* (rotation cadence, revocation = crypto-shredding, audit logs on key
 * use, separation of duties between the data admin and the key admin), not
 * "encryption". That is why the capstone only turns this on for prod.
 *
 * Reading `*Input` getters: those return what the author passed; the un-suffixed
 * getters return interpolation tokens and are useless for validation.
 */
export class RequireCmekAspect implements IAspect {
  private readonly allowed?: Set<string>;

  constructor(props: RequireCmekAspectProps = {}) {
    this.allowed = props.allowedKeys ? new Set(props.allowedKeys) : undefined;
  }

  visit(node: IConstruct): void {
    if (node instanceof StorageBucket) {
      this.check(node, `bucket "${node.nameInput}"`, node.encryptionInput?.defaultKmsKeyName, 'encryption.defaultKmsKeyName');
    } else if (node instanceof SqlDatabaseInstance) {
      this.check(node, `Cloud SQL instance "${node.nameInput}"`, node.encryptionKeyNameInput, 'encryptionKeyName');
    } else if (node instanceof ComputeDisk) {
      this.check(node, `disk "${node.nameInput}"`, node.diskEncryptionKeyInput?.kmsKeySelfLink, 'diskEncryptionKey.kmsKeySelfLink');
    }
  }

  private check(node: IConstruct, what: string, key: string | undefined, field: string): void {
    if (!key) {
      Annotations.of(node).addError(`${what} must use a customer-managed key (set ${field})`);
      return;
    }
    if (this.allowed && !this.allowed.has(key)) {
      Annotations.of(node).addError(`${what} uses key "${key}" which is not in the approved key list`);
    }
  }
}
