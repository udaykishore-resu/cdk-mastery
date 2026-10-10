/**
 * Naming conventions — the least glamorous and most argued-about part of platform
 * engineering. Both clouds impose different limits, so the rule lives in one place
 * and each track adapts the *output*, never the *rule*.
 *
 *   AWS:  most names allow `[A-Za-z0-9-]`, S3 buckets must be lowercase DNS labels,
 *         IAM names up to 64/128 chars, Lambda function names up to 64.
 *   GCP:  most names must match `[a-z]([-a-z0-9]*[a-z0-9])?`, ≤ 63 chars; buckets are
 *         global, ≤ 63 chars; labels keys/values are lowercase `[a-z0-9_-]`.
 */

export interface NameParts {
  /** Organisation or product prefix, e.g. "revan". */
  readonly org: string;
  /** Service / workload, e.g. "orders". */
  readonly service: string;
  /** Environment tier, e.g. "prod". */
  readonly env: string;
  /** Component within the service, e.g. "api", "queue", "db". */
  readonly component: string;
  /** Optional region short-code, e.g. "use1" or "usc1". */
  readonly region?: string;
}

const MAX_GCP_NAME = 63;

/** Lowercase, hyphen-separated, safe for GCP resource names and AWS bucket names. */
export function resourceName(parts: NameParts): string {
  const raw = [parts.org, parts.service, parts.env, parts.component, parts.region]
    .filter((p): p is string => !!p && p.length > 0)
    .map(slugify)
    .join('-');
  if (raw.length > MAX_GCP_NAME) {
    // Deterministic truncation: keep the head, add a short hash of the whole thing.
    return `${raw.slice(0, MAX_GCP_NAME - 9)}-${shortHash(raw)}`;
  }
  return raw;
}

/** Same rule, but GCP labels and AWS tag *values* prefer underscores to survive tooling. */
export function normaliseLabelKey(key: string): string {
  const k = key.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 63);
  // GCP label keys must start with a lowercase letter.
  return /^[a-z]/.test(k) ? k : `k_${k}`.slice(0, 63);
}

export function normaliseLabelValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 63);
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Region short-codes: "us-east-1" → "use1", "us-central1" → "usc1", "europe-west4" → "euw4". */
export function regionShortCode(region: string): string {
  const m = region.match(/^([a-z]+)-([a-z]+)-?(\d+)$/);
  if (!m) return slugify(region).replace(/-/g, '').slice(0, 6);
  const [, geo, dir, num] = m;
  return `${geo.slice(0, 2)}${dir[0]}${num}`;
}

/** Tiny, stable, dependency-free hash (FNV-1a, 32-bit) rendered as 8 hex chars. */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
