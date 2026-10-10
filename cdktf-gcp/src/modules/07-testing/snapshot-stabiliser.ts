/**
 * Snapshot tests are only useful when a diff means "the infrastructure changed".
 * Three things in a synthesized stack change for other reasons:
 *
 *   1. Asset paths: `assets/ConfigAsset/<md5-of-content>/archive.zip`. Editing
 *      a comment in a config file changes the hash and therefore the snapshot.
 *   2. The default local backend path: absolute, includes `process.cwd()`, so it
 *      differs between a laptop and CI.
 *   3. Provider version pins (`terraform.required_providers.google.version`):
 *      bumping the provider should be a *deliberate* review, not 40 snapshot diffs.
 *
 * `stabilise` parses the JSON string returned by `Testing.synth`, replaces those
 * values with fixed placeholders and returns an object (jest serialises objects
 * deterministically; `json-stable-stringify` in `Testing.synth` already sorts keys).
 */
export interface StabiliseOptions {
  /** Replace asset hashes (cdktf: 32 upper-hex chars, md5 of the source tree) with `<hash>`. Default true. */
  readonly assetHashes?: boolean;
  /** Replace `terraform.backend.local.path` with `<local-state>`. Default true. */
  readonly localBackendPath?: boolean;
  /** Replace provider version pins with `<version>`. Default true. */
  readonly providerVersions?: boolean;
}

export function stabilise(synth: string, options: StabiliseOptions = {}): Record<string, unknown> {
  const json = JSON.parse(synth) as Record<string, unknown>;
  const opts = { assetHashes: true, localBackendPath: true, providerVersions: true, ...options };

  const terraform = json.terraform as { backend?: { local?: { path?: string } }; required_providers?: Record<string, { version?: string }> } | undefined;
  if (opts.localBackendPath && terraform?.backend?.local?.path) {
    terraform.backend.local.path = '<local-state>';
  }
  if (opts.providerVersions && terraform?.required_providers) {
    for (const p of Object.values(terraform.required_providers)) {
      if (p.version) p.version = '<version>';
    }
  }
  if (opts.assetHashes) {
    return walk(json, (v) => v.replace(/\/[0-9A-F]{32}(\/|$)/g, '/<hash>$1')) as Record<string, unknown>;
  }
  return json;
}

function walk(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, fn));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, fn)]));
  }
  return value;
}
