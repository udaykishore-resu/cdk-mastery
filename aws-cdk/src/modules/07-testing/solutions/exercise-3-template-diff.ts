export interface TemplateResources {
  Resources?: Record<string, { Type: string; Properties?: unknown; [k: string]: unknown }>;
}

export interface TemplateDiff {
  /** Logical IDs present only in `after`. */
  readonly added: string[];
  /** Logical IDs present only in `before`. */
  readonly removed: string[];
  /** Logical IDs present in both whose JSON differs. */
  readonly changed: string[];
  /**
   * Pairs (removed, added) with the same resource type: the signature of a
   * construct that was *renamed* (its logical ID changed), which CloudFormation
   * executes as delete + create — a replacement, with data loss for stateful
   * resources. `cdk diff` shows the same thing as `[-]` + `[+]`.
   */
  readonly suspectedReplacements: Array<{ from: string; to: string; type: string }>;
}

/**
 * Exercise 3 — a template diff for tests.
 *
 * The full `cdk diff` (package `@aws-cdk/cloudformation-diff`, bundled inside the
 * CLI) knows CloudFormation's per-property replacement semantics. Tests do not
 * need that: they need to catch the two regressions that hurt most —
 *   - a logical ID changed (refactor moved/renamed a construct), and
 *   - a resource disappeared.
 * Both are a set difference on `Resources`. `suspectedReplacements` pairs removed
 * and added IDs of the same type so the failure message says *what* was renamed.
 */
export function diffTemplates(before: TemplateResources, after: TemplateResources): TemplateDiff {
  const b = before.Resources ?? {};
  const a = after.Resources ?? {};
  const added = Object.keys(a).filter((id) => !(id in b)).sort();
  const removed = Object.keys(b).filter((id) => !(id in a)).sort();
  const changed = Object.keys(a)
    .filter((id) => id in b && JSON.stringify(canonical(a[id])) !== JSON.stringify(canonical(b[id])))
    .sort();

  const suspectedReplacements: TemplateDiff['suspectedReplacements'] = [];
  const unmatchedAdded = new Set(added);
  for (const from of removed) {
    const to = [...unmatchedAdded].find((id) => a[id].Type === b[from].Type);
    if (to) {
      unmatchedAdded.delete(to);
      suspectedReplacements.push({ from, to, type: b[from].Type });
    }
  }
  return { added, removed, changed, suspectedReplacements };
}

/** Assertion form: fail when any logical ID vanished — the "logical ID stability" test. */
export function expectStableLogicalIds(before: TemplateResources, after: TemplateResources): void {
  const diff = diffTemplates(before, after);
  if (diff.removed.length === 0) return;
  const detail = diff.suspectedReplacements.map((r) => `  ${r.type}: ${r.from} -> ${r.to} (replacement!)`);
  throw new Error(`Logical IDs removed: ${diff.removed.join(', ')}\n${detail.join('\n')}`);
}

/** Deterministic key order so object-key ordering never counts as a change. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
