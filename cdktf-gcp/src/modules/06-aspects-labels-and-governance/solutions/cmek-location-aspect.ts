import { Annotations, IAspect, IResolveContext, TerraformStack, Token, Tokenization } from 'cdktf';
import { IConstruct } from 'constructs';
import { KmsCryptoKey } from '@cdktf/provider-google/lib/kms-crypto-key';
import { KmsKeyRing } from '@cdktf/provider-google/lib/kms-key-ring';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';

/**
 * Exercise 3 (hard): the KMS key protecting a bucket must live in a location
 * compatible with the bucket, otherwise every object write fails at runtime
 * with a 400 — long after `terraform apply` said everything was fine.
 *
 * Rules (from the GCS CMEK docs):
 *   - regional bucket  (`US-CENTRAL1`) -> key in that region, or the matching
 *     multi-region (`us` for US regions, `europe` for EU regions).
 *   - multi-region bucket (`US`, `EU`, `ASIA`) -> key in the same multi-region
 *     (KMS spells them `us`, `europe`, `asia`).
 *   - dual-region bucket (`NAM4`, `EUR4`, ...) -> key in the matching multi-region
 *     (`us` for NAM*, `europe` for EUR*, `asia` for ASIA1).
 *
 * Two hard parts.
 *
 * 1. The bucket references the key by *token* (`${TfToken[TOKEN.12]}`), and every
 *    read of `key.id` mints a *new* token, so `bucket.encryptionInput.defaultKmsKeyName
 *    === key.id` is false even when they refer to the same attribute. Tokens must
 *    be *resolved* to compare them: `Tokenization.reverseString(s)` recovers the
 *    IResolvable, and resolving it in the stack's scope yields the stable
 *    interpolation `${google_kms_crypto_key.K.id}`. `resolveReference` below does
 *    that with a minimal IResolveContext.
 *
 * 2. Sibling order is construction order, so a bucket may be visited before the
 *    key it uses. The aspect therefore only *collects* during `visit` and
 *    validates in `finalize()`, which it registers as a node validation on the
 *    stack. Validations run after every aspect has completed.
 */
export class CmekLocationAspect implements IAspect {
  private readonly keys = new Map<string, KmsCryptoKey>(); // "${google_kms_crypto_key.X.id}" -> key
  private readonly rings = new Map<string, KmsKeyRing>(); // "${google_kms_key_ring.X.id}" -> ring
  private readonly buckets: StorageBucket[] = [];
  private registered = false;

  visit(node: IConstruct): void {
    if (!this.registered) {
      // `runAllValidations()` walks the *stack's* subtree (terraform-stack.js), so
      // the validation must hang off the stack, not the App. It runs in
      // `app.synth()`, `Testing.fullSynth(stack)` and `Testing.synth(stack, true)`;
      // NOT in the default `Testing.synth(stack)`, which skips validations.
      TerraformStack.of(node).node.addValidation({ validate: () => this.finalize() });
      this.registered = true;
    }
    if (node instanceof KmsKeyRing) this.rings.set(resolveReference(node, node.id), node);
    if (node instanceof KmsCryptoKey) this.keys.set(resolveReference(node, node.id), node);
    if (node instanceof StorageBucket) this.buckets.push(node);
  }

  /** Returns the list of violations and annotates each offending bucket. */
  finalize(): string[] {
    const errors: string[] = [];
    for (const bucket of this.buckets) {
      const keyRef = bucket.encryptionInput?.defaultKmsKeyName;
      const location = bucket.locationInput;
      if (!keyRef || !location || Token.isUnresolved(location)) continue;
      const key = this.keys.get(resolveReference(bucket, keyRef));
      if (!key) continue; // key defined elsewhere (another stack, literal string): cannot judge here
      const ringRef = key.keyRingInput;
      const ring = ringRef ? this.rings.get(resolveReference(key, ringRef)) : undefined;
      const keyLocation = ring?.locationInput;
      if (!keyLocation || Token.isUnresolved(keyLocation)) continue;
      if (!isCompatible(location, keyLocation)) {
        const message = `bucket "${bucket.nameInput}" in ${location} uses a key in ${keyLocation}; allowed: ${compatibleKeyLocations(location).join(', ')}`;
        Annotations.of(bucket).addError(message);
        errors.push(message);
      }
    }
    return errors;
  }
}

/**
 * Resolve a string that may be a single reference token into its Terraform
 * interpolation (`${google_kms_crypto_key.K.id}`). Plain strings are returned
 * unchanged. Used to compare references by *identity of the referenced
 * attribute* instead of by token id.
 */
export function resolveReference(scope: IConstruct, value: string): string {
  if (!Token.isUnresolved(value)) return value;
  const fragments = Tokenization.reverseString(value);
  if (fragments.tokens.length !== 1) return value;
  const context: IResolveContext = {
    scope,
    preparing: false,
    resolve: (x: unknown) => x,
    registerPostProcessor: () => undefined,
  };
  return String(fragments.tokens[0].resolve(context));
}

/** KMS locations that may protect a bucket in `bucketLocation`. */
export function compatibleKeyLocations(bucketLocation: string): string[] {
  const loc = bucketLocation.toLowerCase();
  if (['us', 'eu', 'asia'].includes(loc)) return [loc === 'eu' ? 'europe' : loc];
  if (/^nam\d+$/.test(loc)) return ['us'];
  if (/^eur\d+$/.test(loc)) return ['europe'];
  if (/^asia\d+$/.test(loc)) return ['asia'];
  // regional
  const multi = loc.startsWith('us-') || loc.startsWith('northamerica-') ? 'us' : loc.startsWith('europe-') ? 'europe' : loc.startsWith('asia-') ? 'asia' : undefined;
  return multi ? [loc, multi] : [loc];
}

export function isCompatible(bucketLocation: string, keyLocation: string): boolean {
  return compatibleKeyLocations(bucketLocation).includes(keyLocation.toLowerCase());
}
