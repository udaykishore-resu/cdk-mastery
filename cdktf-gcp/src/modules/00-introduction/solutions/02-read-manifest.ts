/**
 * Exercise 2 — read `manifest.json` back.
 *
 * The CLI's `cdktf list` and `cdktf deploy` do not look at your TypeScript at
 * all; they read `cdktf.out/manifest.json`, which is the index of every stack,
 * where its `cdk.tf.json` lives, and which stacks it depends on. Write a
 * function that returns that index so you can reason about deploy order
 * without the CLI.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface StackSummary {
  readonly name: string;
  /** Path of the stack's Terraform JSON, relative to the output directory. */
  readonly configPath: string;
  /** Names of stacks that must be applied first (cross-stack references, module 02). */
  readonly dependencies: readonly string[];
  /** Top-level keys of the synthesized `cdk.tf.json` (e.g. provider, resource, terraform). */
  readonly sections: readonly string[];
  readonly resourceCount: number;
}

export interface SynthSummary {
  readonly version: string;
  readonly stacks: readonly StackSummary[];
}

interface ManifestFile {
  readonly version: string;
  readonly stacks: Record<
    string,
    { readonly name: string; readonly synthesizedStackPath: string; readonly dependencies: string[] }
  >;
}

export function describeSynth(outdir: string): SynthSummary {
  const manifest = JSON.parse(fs.readFileSync(path.join(outdir, 'manifest.json'), 'utf8')) as ManifestFile;
  const stacks = Object.values(manifest.stacks).map((entry): StackSummary => {
    const config = JSON.parse(fs.readFileSync(path.join(outdir, entry.synthesizedStackPath), 'utf8')) as Record<
      string,
      unknown
    >;
    const resources = (config.resource ?? {}) as Record<string, Record<string, unknown>>;
    const resourceCount = Object.values(resources).reduce((n, byId) => n + Object.keys(byId).length, 0);
    return {
      name: entry.name,
      configPath: entry.synthesizedStackPath,
      dependencies: entry.dependencies,
      sections: Object.keys(config).filter((k) => k !== '//'),
      resourceCount,
    };
  });
  return { version: manifest.version, stacks };
}

/**
 * Topological deploy order (Kahn's algorithm). This is what `cdktf deploy '*'`
 * computes internally; having it in hand lets CI print the plan of plans.
 */
export function deployOrder(summary: SynthSummary): string[] {
  const remaining = new Map(summary.stacks.map((s) => [s.name, new Set(s.dependencies)]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([name]) => name);
    if (ready.length === 0) {
      throw new Error(`Circular stack dependencies among: ${[...remaining.keys()].join(', ')}`);
    }
    for (const name of ready.sort()) {
      order.push(name);
      remaining.delete(name);
      for (const deps of remaining.values()) deps.delete(name);
    }
  }
  return order;
}
