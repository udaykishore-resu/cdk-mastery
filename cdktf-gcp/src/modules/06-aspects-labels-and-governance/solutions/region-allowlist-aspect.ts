import { Annotations, IAspect, TerraformResource, Token } from 'cdktf';
import { IConstruct } from 'constructs';

export interface RegionAllowlistAspectProps {
  /** Regions such as `us-central1`, `europe-west4`. Case-insensitive. */
  readonly allowedRegions: string[];
  /**
   * Multi-region / dual-region location codes to accept for resources that use
   * `location` (GCS, KMS, BigQuery): e.g. `US`, `EU`, `NAM4`. Defaults to none.
   */
  readonly allowedMultiRegions?: string[];
  /** Use `warn` for a report-only rollout, `error` (default) to block synth. */
  readonly severity?: 'warn' | 'error';
}

/**
 * Exercise 2 (medium): data residency. Flag any resource whose `region`,
 * `location` or `zone` argument is outside the allow-list.
 *
 * The interesting part is not the comparison, it is *finding the value* without
 * enumerating resource classes. Same fingerprinting technique as `LabelsAspect`:
 * the generator emits `regionInput` / `locationInput` / `zoneInput` getters for
 * every resource with those arguments. Tokens (`${var.region}`) are skipped —
 * they are not knowable at synth time; that is what `precondition` is for.
 *
 * Zones are mapped to their region by dropping the trailing `-x`.
 */
export class RegionAllowlistAspect implements IAspect {
  private readonly regions: Set<string>;
  private readonly multi: Set<string>;
  private readonly severity: 'warn' | 'error';

  constructor(props: RegionAllowlistAspectProps) {
    this.regions = new Set(props.allowedRegions.map((r) => r.toLowerCase()));
    this.multi = new Set((props.allowedMultiRegions ?? []).map((r) => r.toLowerCase()));
    this.severity = props.severity ?? 'error';
  }

  visit(node: IConstruct): void {
    if (!(node instanceof TerraformResource)) return;
    const candidates: Array<[string, string | undefined]> = [
      ['region', readInput(node, 'regionInput')],
      ['location', readInput(node, 'locationInput')],
      ['zone', readInput(node, 'zoneInput')],
    ];
    for (const [field, raw] of candidates) {
      if (raw === undefined || Token.isUnresolved(raw)) continue;
      const value = raw.toLowerCase();
      // `global` is a legitimate location for some resources (KMS keys, WIF pools).
      if (value === 'global') continue;
      const region = field === 'zone' ? value.replace(/-[a-z]$/, '') : value;
      if (this.regions.has(region) || this.multi.has(value)) continue;
      const message = `${node.terraformResourceType} ${field}="${raw}" is outside the allowed regions (${[...this.regions].join(', ')})`;
      if (this.severity === 'error') Annotations.of(node).addError(message);
      else Annotations.of(node).addWarning(message);
    }
  }
}

function readInput(node: TerraformResource, getter: string): string | undefined {
  if (!(getter in node)) return undefined;
  const value = (node as unknown as Record<string, unknown>)[getter];
  return typeof value === 'string' ? value : undefined;
}
