package main

import rego.v1

public_principals := {"allUsers", "allAuthenticatedUsers"}

# Any *_iam_member resource granting a role to a public principal.
deny contains msg if {
	some type, instances in input.resource
	endswith(type, "_iam_member")
	some name, cfg in instances
	cfg.member in public_principals
	msg := sprintf("%s.%s: grants %s to %s", [type, name, cfg.role, cfg.member])
}

# Any *_iam_binding whose members list contains a public principal.
deny contains msg if {
	some type, instances in input.resource
	endswith(type, "_iam_binding")
	some name, cfg in instances
	some m in cfg.members
	m in public_principals
	msg := sprintf("%s.%s: grants %s to %s", [type, name, cfg.role, m])
}

# *_iam_policy is authoritative: it silently removes every binding not listed,
# including the Google-managed service agents. Require an explicit opt-in.
deny contains msg if {
	some type, instances in input.resource
	endswith(type, "_iam_policy")
	some name, _ in instances
	msg := sprintf("%s.%s: authoritative IAM policies are not allowed; use *_iam_member", [type, name])
}

# Primitive roles are too broad for anything that is not a sandbox.
primitive_roles := {"roles/owner", "roles/editor"}

deny contains msg if {
	some type, instances in input.resource
	endswith(type, "_iam_member")
	some name, cfg in instances
	cfg.role in primitive_roles
	msg := sprintf("%s.%s: primitive role %s is not allowed", [type, name, cfg.role])
}

# User-managed service account keys: the thing Workload Identity Federation exists to replace.
deny contains msg if {
	some name, _ in input.resource.google_service_account_key
	msg := sprintf("google_service_account_key.%s: service account keys are banned; use WIF", [name])
}
