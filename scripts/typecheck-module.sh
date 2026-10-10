#!/usr/bin/env bash
# Type-check a single module (and its test) in isolation.
# Usage: scripts/typecheck-module.sh <aws-cdk|cdktf-gcp> <NN-slug>
set -euo pipefail
track="$1"; mod="$2"
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
cat > "$tmp/tsconfig.json" <<JSON
{
  "extends": "$root/tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "baseUrl": "$root/$track", "paths": { "@cdk-mastery/shared": ["$root/shared/src/index.ts"] }, "typeRoots": ["$root/node_modules/@types"] },
  "include": ["$root/$track/src/modules/$mod/**/*.ts", "$root/$track/test/$mod*.ts", "$root/$track/test/setup.ts", "$root/shared/src/**/*.ts"]
}
JSON
cd "$root/$track" && npx tsc -p "$tmp/tsconfig.json"
echo "typecheck OK: $track/$mod"
rm -rf "$tmp"
