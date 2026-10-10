# Conftest / OPA rules for the synthesized cdk.tf.json of every stack.
#
# Run after `cdktf synth`:
#   conftest test cdktf.out/stacks/*/cdk.tf.json -p src/modules/06-aspects-labels-and-governance/policy/
#
# Input document shape (Terraform JSON configuration syntax):
#   { "resource": { "google_storage_bucket": { "<logical id>": { ...args } } }, ... }
#
# Rego v1 syntax (`import rego.v1`, `contains ... if`) needs conftest >= 0.46 /
# OPA >= 0.59. It is the syntax OPA 1.0 makes mandatory.
package main

import rego.v1

buckets contains [name, cfg] if {
	some name, cfg in input.resource.google_storage_bucket
}

# Deny buckets without uniform bucket-level access (legacy ACLs are the #1
# source of accidental public objects).
deny contains msg if {
	some [name, cfg] in buckets
	not cfg.uniform_bucket_level_access == true
	msg := sprintf("google_storage_bucket.%s: uniform_bucket_level_access must be true", [name])
}

# Deny buckets whose public access prevention is not enforced.
deny contains msg if {
	some [name, cfg] in buckets
	not cfg.public_access_prevention == "enforced"
	msg := sprintf("google_storage_bucket.%s: public_access_prevention must be \"enforced\"", [name])
}

# Warn (do not fail) on buckets without CMEK. Prod stacks are expected to have it;
# dev stacks trade it for cost. Promote to `deny` for a prod-only policy folder.
warn contains msg if {
	some [name, cfg] in buckets
	not cfg.encryption.default_kms_key_name
	msg := sprintf("google_storage_bucket.%s: no customer-managed encryption key", [name])
}

# Every labelled resource must carry the mandatory labels from
# shared/src/environment.ts (mandatoryTags). Resources that cannot carry labels
# are skipped by construction: only entries with a `labels` object are checked.
required_labels := {"environment", "owner", "cost-center", "managed-by"}

deny contains msg if {
	some type, instances in input.resource
	some name, cfg in instances
	cfg.labels
	missing := required_labels - {k | some k, _ in cfg.labels}
	count(missing) > 0
	msg := sprintf("%s.%s: missing mandatory labels %v", [type, name, missing])
}
