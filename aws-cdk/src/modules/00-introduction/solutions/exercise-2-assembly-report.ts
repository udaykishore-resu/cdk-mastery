import * as cxapi from 'aws-cdk-lib/cx-api';

/**
 * Exercise 2 — read a cloud assembly programmatically.
 *
 * `cdk.out` is a stable, documented contract (the "cloud assembly schema", versioned in
 * `manifest.json`). Anything that can read JSON can consume it: your own policy checks,
 * a cost estimator, a PR bot that lists resource types being added. This function reads
 * the assembly the way the CLI does — through `cx-api`, not by globbing files.
 */
export interface StackReport {
  readonly stackName: string;
  /** `aws://<account>/<region>`; `unknown-account`/`unknown-region` for env-agnostic stacks. */
  readonly environment: string;
  /** Resource type -> count, e.g. `{ 'AWS::S3::Bucket': 1 }`. */
  readonly resourceTypes: Record<string, number>;
  /** Names of the template's Outputs. */
  readonly outputs: string[];
  /** Bootstrap stack version this stack's synthesizer demands (6 for `DefaultStackSynthesizer`). */
  readonly requiresBootstrapStackVersion?: number;
  /** IDs of artifacts this stack depends on (its own asset manifest, other stacks). */
  readonly dependencies: string[];
}

export function reportAssembly(assembly: cxapi.CloudAssembly): StackReport[] {
  // `stacksRecursively` also descends into nested Stages; `stacks` is top-level only.
  return assembly.stacksRecursively.map((artifact) => {
    const resources = (artifact.template.Resources ?? {}) as Record<string, { Type: string }>;
    const resourceTypes: Record<string, number> = {};
    for (const r of Object.values(resources)) {
      resourceTypes[r.Type] = (resourceTypes[r.Type] ?? 0) + 1;
    }
    return {
      stackName: artifact.stackName,
      environment: artifact.environment.name,
      resourceTypes,
      outputs: Object.keys(artifact.template.Outputs ?? {}),
      requiresBootstrapStackVersion: artifact.requiresBootstrapStackVersion,
      dependencies: artifact.dependencies.map((d) => d.id),
    };
  });
}

/** Render the report as text (what a CI job would post on a pull request). */
export function formatReport(reports: StackReport[]): string {
  return reports
    .map((r) => {
      const types = Object.entries(r.resourceTypes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([t, n]) => `    ${t} x${n}`)
        .join('\n');
      return `${r.stackName} (${r.environment}, bootstrap>=${r.requiresBootstrapStackVersion ?? 'n/a'})\n${types}`;
    })
    .join('\n');
}
