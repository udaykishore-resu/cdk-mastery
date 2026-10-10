import { Template } from 'aws-cdk-lib/assertions';

export interface WildcardFinding {
  readonly logicalId: string;
  readonly resourceType: string;
  readonly sid?: string;
  readonly reason: string;
}

/**
 * Exercise 1 — a reusable assertion helper.
 *
 * `Template` has no "assert nothing matches" beyond `resourcePropertiesCountIs(…, 0)`,
 * and IAM statements are nested arrays where `Action`/`Resource` may be a string
 * *or* an array. A helper that walks `findResources` output and normalises the
 * shapes is the honest way to express "no policy in this stack grants `*`".
 *
 * Returns findings instead of throwing so the caller decides the severity; the
 * `expectNoWildcardIam` wrapper is what tests call.
 */
export function findWildcardIam(template: Template): WildcardFinding[] {
  const findings: WildcardFinding[] = [];
  const policyDocs: Array<{ logicalId: string; type: string; doc: unknown }> = [];

  for (const type of ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy']) {
    for (const [logicalId, res] of Object.entries(template.findResources(type))) {
      policyDocs.push({ logicalId, type, doc: res.Properties?.PolicyDocument });
    }
  }
  for (const [logicalId, res] of Object.entries(template.findResources('AWS::IAM::Role'))) {
    for (const inline of res.Properties?.Policies ?? []) {
      policyDocs.push({ logicalId, type: 'AWS::IAM::Role', doc: inline.PolicyDocument });
    }
  }

  for (const { logicalId, type, doc } of policyDocs) {
    const statements = (doc as { Statement?: unknown[] } | undefined)?.Statement ?? [];
    for (const raw of statements) {
      const st = raw as { Effect?: string; Sid?: string; Action?: unknown; Resource?: unknown };
      if (st.Effect !== 'Allow') continue;
      if (asList(st.Action).includes('*')) findings.push({ logicalId, resourceType: type, sid: st.Sid, reason: 'Action: *' });
      if (asList(st.Resource).includes('*')) findings.push({ logicalId, resourceType: type, sid: st.Sid, reason: 'Resource: *' });
    }
  }
  return findings;
}

export function expectNoWildcardIam(template: Template): void {
  const findings = findWildcardIam(template);
  if (findings.length === 0) return;
  const lines = findings.map((f) => `  ${f.resourceType} ${f.logicalId}${f.sid ? ` (Sid ${f.sid})` : ''}: ${f.reason}`);
  throw new Error(`Wildcard IAM permissions found:\n${lines.join('\n')}`);
}

function asList(value: unknown): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string');
}
