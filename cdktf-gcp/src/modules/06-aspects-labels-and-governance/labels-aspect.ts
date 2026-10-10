import { IAspect, TerraformResource, Token } from 'cdktf';
import { IConstruct } from 'constructs';
import { normaliseLabelKey, normaliseLabelValue } from '@cdk-mastery/shared';

/**
 * A resource that exposes Terraform's `labels` argument through the prebuilt
 * provider bindings. Every jsii-generated resource class with a `labels`
 * attribute has exactly this shape (see the technique note below).
 */
export interface LabelledResource extends TerraformResource {
  labels: Record<string, string>;
  readonly labelsInput: Record<string, string> | undefined;
}

/**
 * Detects "this resource accepts labels" without knowing the resource class.
 *
 * The technique: `@cdktf/provider-google` classes are generated from the provider
 * schema. For every optional argument `foo` the generator emits, on the class
 * *prototype*, a getter `foo` (returns an interpolation token, never the raw
 * value), a setter `foo`, `resetFoo()` and a getter `fooInput` (returns what was
 * passed to the constructor or set later). `labelsInput` is therefore a reliable
 * fingerprint for "has a settable `labels` argument", and because it lives on the
 * prototype, the `in` operator finds it (`'labelsInput' in node`), unlike
 * `Object.keys` / `hasOwnProperty`, which only see instance fields.
 *
 * We read `labelsInput`, not `labels`: `node.labels` returns a
 * `${google_storage_bucket.X.labels}` token, and spreading a token into a new
 * object would produce nonsense.
 *
 * The `instanceof TerraformResource` guard matters: data sources and providers
 * also carry `*Input` getters, and `google_project`'s `labels` on a *data source*
 * is read-only. Restricting to resources keeps the aspect from writing where it
 * cannot.
 */
export function isLabelledResource(node: IConstruct): node is LabelledResource {
  if (!(node instanceof TerraformResource)) return false;
  if (!('labelsInput' in node)) return false;
  // Belt and braces: confirm a setter exists somewhere up the prototype chain.
  // (`labelsInput` alone would also match a hypothetical read-only attribute.)
  let proto = Object.getPrototypeOf(node);
  while (proto && proto !== Object.prototype) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'labels');
    if (desc) return typeof desc.set === 'function';
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

export interface LabelsAspectProps {
  /** Labels to apply. Keys/values are normalised to GCP's `[a-z0-9_-]`, ≤ 63 chars. */
  readonly labels: Record<string, string>;
  /**
   * When true (default), labels already set on the resource win over the aspect's.
   * Set to false to make the aspect authoritative (e.g. `environment` must never
   * be overridden by a construct author).
   */
  readonly existingWins?: boolean;
}

/**
 * Mutating aspect: merges `labels` into every resource that accepts them.
 *
 * Runs once per node, after the whole tree is built and before `toTerraform()`
 * (see `invokeAspects` in cdktf/lib/synthesize/synthesizer.js). That ordering is
 * what makes "label everything" a one-liner instead of a convention every author
 * must remember.
 */
export class LabelsAspect implements IAspect {
  private readonly labels: Record<string, string>;
  private readonly existingWins: boolean;
  /** Construct paths that were labelled; handy for tests and reports. */
  readonly applied: string[] = [];

  constructor(props: LabelsAspectProps) {
    this.labels = normaliseLabels(props.labels);
    this.existingWins = props.existingWins ?? true;
  }

  visit(node: IConstruct): void {
    if (!isLabelledResource(node)) return;
    const existing = normaliseLabels(node.labelsInput ?? {});
    node.labels = this.existingWins ? { ...this.labels, ...existing } : { ...existing, ...this.labels };
    this.applied.push(node.node.path);
  }
}

/**
 * Normalise a label map. Values that are unresolved tokens (`${var.x}`,
 * `${google_project.p.number}`) are passed through untouched: lower-casing a
 * token string would corrupt the token's encoded id and break resolution.
 */
export function normaliseLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    const key = Token.isUnresolved(k) ? k : normaliseLabelKey(k);
    out[key] = Token.isUnresolved(v) ? v : normaliseLabelValue(v);
  }
  return out;
}
