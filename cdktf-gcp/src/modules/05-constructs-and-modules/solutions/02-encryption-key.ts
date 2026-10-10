/**
 * Exercise 2 — an `EncryptionKey` construct with a `grant*` API.
 *
 * CMEK on GCP is always the same three steps: a key ring (immutable, never
 * deletable), a key with rotation, and a grant of
 * `roles/cloudkms.cryptoKeyEncrypterDecrypter` to whichever *service agent*
 * will encrypt on your behalf (GCS, Pub/Sub, BigQuery, Cloud SQL — each has
 * its own). Package that so callers write `key.grantEncryptDecrypt(agent)`
 * and validate the rotation period at synth (KMS requires ≥ 1 day; policy
 * usually wants ≤ 90).
 */
import { Annotations } from 'cdktf';
import { Construct } from 'constructs';
import { KmsKeyRing } from '@cdktf/provider-google/lib/kms-key-ring';
import { KmsCryptoKey } from '@cdktf/provider-google/lib/kms-crypto-key';
import { KmsCryptoKeyIamMember } from '@cdktf/provider-google/lib/kms-crypto-key-iam-member';
import { EnvironmentTier, mandatoryTags } from '@cdk-mastery/shared';

export interface EncryptionKeyProps {
  readonly tier: EnvironmentTier;
  readonly keyRingName: string;
  readonly keyName: string;
  readonly location: string;
  /** Rotation period in days. Default 90; must be 1..365. */
  readonly rotationDays?: number;
  /** Reuse an existing ring (rings cannot be deleted, so reuse is the norm after the first apply). */
  readonly existingKeyRingId?: string;
}

export class EncryptionKey extends Construct {
  readonly keyRing?: KmsKeyRing;
  readonly key: KmsCryptoKey;
  readonly keyId: string;
  private grantCounter = 0;

  constructor(scope: Construct, id: string, props: EncryptionKeyProps) {
    super(scope, id);
    const rotationDays = props.rotationDays ?? 90;

    this.node.addValidation({
      validate: () =>
        Number.isInteger(rotationDays) && rotationDays >= 1 && rotationDays <= 365
          ? []
          : [`rotationDays must be an integer in [1, 365], got ${rotationDays}`],
    });
    if (props.tier.retainStatefulResources && rotationDays > 90) {
      Annotations.of(this).addWarning(`rotation of ${rotationDays} days exceeds the 90-day policy for ${props.tier.name}`);
    }

    let ringId = props.existingKeyRingId;
    if (!ringId) {
      this.keyRing = new KmsKeyRing(this, 'Ring', { name: props.keyRingName, location: props.location });
      ringId = this.keyRing.id;
    }

    this.key = new KmsCryptoKey(this, 'Key', {
      name: props.keyName,
      keyRing: ringId,
      rotationPeriod: `${rotationDays * 86400}s`,
      purpose: 'ENCRYPT_DECRYPT',
      versionTemplate: { algorithm: 'GOOGLE_SYMMETRIC_ENCRYPTION', protectionLevel: props.tier.highlyAvailable ? 'HSM' : 'SOFTWARE' },
      // Keys are never destroyed with data behind them; Terraform "destroy" only
      // removes it from state unless this is false.
      lifecycle: { preventDestroy: props.tier.retainStatefulResources },
      labels: mandatoryTags(props.tier, 'kms'),
    });
    this.keyId = this.key.id;
  }

  /** Grant a service agent (or any principal) use of the key for encryption and decryption. */
  grantEncryptDecrypt(member: string, id = `Use${this.grantCounter++}`): KmsCryptoKeyIamMember {
    return new KmsCryptoKeyIamMember(this, id, { cryptoKeyId: this.key.id, role: 'roles/cloudkms.cryptoKeyEncrypterDecrypter', member });
  }

  /** Read-only key metadata (e.g. for a service that needs to list versions but not use them). */
  grantViewer(member: string, id = `View${this.grantCounter++}`): KmsCryptoKeyIamMember {
    return new KmsCryptoKeyIamMember(this, id, { cryptoKeyId: this.key.id, role: 'roles/cloudkms.viewer', member });
  }
}
