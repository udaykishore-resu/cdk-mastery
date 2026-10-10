/**
 * Exercise 1 (easy): counting helpers over the synthesized JSON.
 *
 * `toHaveResource` answers "is there at least one?"; production reviews ask
 * "how many?" (one NAT per region, exactly one backend, no orphan topics).
 */
export interface SynthesizedStack {
  readonly resource?: Record<string, Record<string, unknown>>;
  readonly data?: Record<string, Record<string, unknown>>;
  readonly output?: Record<string, unknown>;
  readonly variable?: Record<string, unknown>;
  readonly terraform?: { backend?: Record<string, unknown> };
}

export function parse(synth: string): SynthesizedStack {
  return JSON.parse(synth) as SynthesizedStack;
}

/** Number of resource instances of `type` (a Terraform type such as `google_pubsub_topic`). */
export function countResources(synth: string, type: string): number {
  return Object.keys(parse(synth).resource?.[type] ?? {}).length;
}

/** Number of data-source instances of `type`. */
export function countDataSources(synth: string, type: string): number {
  return Object.keys(parse(synth).data?.[type] ?? {}).length;
}

/** `{ google_pubsub_topic: 2, google_storage_bucket: 1, ... }` — handy as an inline snapshot. */
export function resourceInventory(synth: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [type, instances] of Object.entries(parse(synth).resource ?? {})) {
    out[type] = Object.keys(instances).length;
  }
  return out;
}

/** All logical ids of a type, sorted. */
export function logicalIds(synth: string, type: string): string[] {
  return Object.keys(parse(synth).resource?.[type] ?? {}).sort();
}
