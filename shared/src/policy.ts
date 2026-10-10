import { IConstruct } from 'constructs';

/**
 * A framework-agnostic policy walker.
 *
 * AWS CDK has `Aspects` + `IAspect`; CDKTF has `Aspects` + `IAspect` too (it copied
 * the design). Both visit every node of the construct tree after the app is built
 * and before synthesis. Their `IAspect` interfaces are different TypeScript types
 * but structurally identical: `{ visit(node: IConstruct): void }`.
 *
 * `ConstructPolicy` is written against the *shared* `constructs` type, so a policy
 * defined here can be handed to `Aspects.of(app).add(...)` in either framework.
 * The tracks' module 06 shows both.
 */
export interface PolicyViolation {
  readonly path: string;
  readonly rule: string;
  readonly message: string;
}

export interface ConstructRule {
  readonly id: string;
  /** Return a message to flag a violation, or `undefined` to pass. */
  check(node: IConstruct): string | undefined;
}

export class ConstructPolicy {
  readonly violations: PolicyViolation[] = [];

  constructor(private readonly rules: ConstructRule[]) {}

  /** Structural match for both AWS CDK's and CDKTF's `IAspect`. */
  visit(node: IConstruct): void {
    for (const rule of this.rules) {
      const message = rule.check(node);
      if (message) {
        this.violations.push({ path: node.node.path, rule: rule.id, message });
      }
    }
  }

  /** Walk a tree without the framework's Aspects machinery (useful in unit tests). */
  walk(root: IConstruct): PolicyViolation[] {
    for (const node of root.node.findAll()) this.visit(node);
    return this.violations;
  }

  throwIfViolated(): void {
    if (this.violations.length === 0) return;
    const lines = this.violations.map((v) => `  [${v.rule}] ${v.path}: ${v.message}`);
    throw new Error(`Policy violations:\n${lines.join('\n')}`);
  }
}

/**
 * Example rule usable in both frameworks: every construct id must be PascalCase
 * (a house style many platform teams enforce so logical IDs are stable and readable).
 */
export const PascalCaseIds: ConstructRule = {
  id: 'naming/pascal-case-ids',
  check(node) {
    const id = node.node.id;
    if (id === '' || id === 'Default' || id === 'Resource') return undefined; // framework-internal ids
    if (/^[A-Z][A-Za-z0-9]*$/.test(id)) return undefined;
    // Allow framework-generated ids that carry a hash suffix, and stage/env prefixes like "prod-Orders".
    if (/^[a-z]+-[A-Z][A-Za-z0-9]*$/.test(id)) return undefined;
    return `construct id "${id}" is not PascalCase`;
  },
};

/** Depth guard: trees deeper than this usually mean someone nested stacks inside constructs by mistake. */
export function maxDepthRule(maxDepth: number): ConstructRule {
  return {
    id: 'structure/max-depth',
    check(node) {
      const depth = node.node.path.split('/').length;
      return depth > maxDepth ? `depth ${depth} exceeds ${maxDepth}` : undefined;
    },
  };
}
