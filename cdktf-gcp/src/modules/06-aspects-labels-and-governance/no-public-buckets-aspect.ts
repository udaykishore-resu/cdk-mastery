import { Annotations, IAspect } from 'cdktf';
import { IConstruct } from 'constructs';
import { StorageBucket } from '@cdktf/provider-google/lib/storage-bucket';
import { StorageBucketIamBinding } from '@cdktf/provider-google/lib/storage-bucket-iam-binding';
import { StorageBucketIamMember } from '@cdktf/provider-google/lib/storage-bucket-iam-member';

/** The two principals that make a GCS bucket world-readable. */
export const PUBLIC_PRINCIPALS: ReadonlySet<string> = new Set(['allUsers', 'allAuthenticatedUsers']);

/**
 * Validating (read-only) aspect: no bucket in this tree may be public.
 *
 * Three ways a bucket becomes public, three checks:
 *   1. `google_storage_bucket_iam_member` with member `allUsers` / `allAuthenticatedUsers`.
 *   2. `google_storage_bucket_iam_binding` whose `members` list contains one of them.
 *   3. A bucket without `public_access_prevention = "enforced"`. The default is
 *      "inherited", which means "whatever the org policy says", which in an org
 *      without `storage.publicAccessPrevention` means "public if someone grants it".
 *      Defence in depth: the org policy in `org-policies.ts` is the outer wall, the
 *      bucket setting is the inner one, this aspect is the linter for the inner one.
 *
 * Errors are attached with `Annotations.of(node).addError(...)`. That does NOT
 * throw here. It records an `@cdktf/error` metadata entry on the node; the
 * StackSynthesizer collects those into `manifest.json` and throws
 * `Encountered Annotations with level "ERROR"` at synthesis. See the README for
 * exactly which entry points throw and which do not.
 */
export class NoPublicBucketsAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof StorageBucketIamMember) {
      const member = node.memberInput;
      if (member && PUBLIC_PRINCIPALS.has(member)) {
        Annotations.of(node).addError(`bucket IAM member "${member}" makes bucket "${node.bucketInput}" public`);
      }
      return;
    }
    if (node instanceof StorageBucketIamBinding) {
      const bad = (node.membersInput ?? []).filter((m) => PUBLIC_PRINCIPALS.has(m));
      if (bad.length > 0) {
        Annotations.of(node).addError(`bucket IAM binding grants ${node.roleInput} to ${bad.join(', ')}`);
      }
      return;
    }
    if (node instanceof StorageBucket) {
      if (node.publicAccessPreventionInput !== 'enforced') {
        Annotations.of(node).addError(
          `bucket "${node.nameInput}" must set publicAccessPrevention: 'enforced' (got ${JSON.stringify(node.publicAccessPreventionInput ?? 'inherited')})`,
        );
      }
    }
  }
}
