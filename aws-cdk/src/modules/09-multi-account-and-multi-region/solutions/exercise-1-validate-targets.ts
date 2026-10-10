import { DeploymentTarget } from '../targets';

/**
 * Exercise 1 — validate the environment table before anything synthesizes.
 *
 * The table is code, so a typo (11-digit account, `us-east1`) or a policy
 * breach (prod sharing an account with dev) is a *unit test failure*, not a
 * CloudFormation error an hour later. Rules encoded:
 *
 *   - account ids are 12 digits; regions match `<geo>-<dir>-<n>`
 *   - prod never shares an account with a non-prod tier
 *   - `globalRegion`, when set, is us-east-1 (CloudFront/WAF control plane)
 *   - regions are drawn from an allow-list (data residency / SCP alignment)
 */
export interface TargetViolation {
  readonly tier: string;
  readonly rule: string;
  readonly message: string;
}

export function validateTargets(targets: Record<string, DeploymentTarget>, allowedRegions: string[]): TargetViolation[] {
  const violations: TargetViolation[] = [];
  const entries = Object.entries(targets);

  for (const [name, t] of entries) {
    if (!/^\d{12}$/.test(t.env.account)) violations.push({ tier: name, rule: 'account-format', message: `account "${t.env.account}" is not 12 digits` });
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(t.env.region)) violations.push({ tier: name, rule: 'region-format', message: `region "${t.env.region}" is malformed` });
    if (!allowedRegions.includes(t.env.region)) violations.push({ tier: name, rule: 'region-allowlist', message: `region "${t.env.region}" is not allowed` });
    if (t.globalRegion && t.globalRegion !== 'us-east-1') violations.push({ tier: name, rule: 'global-region', message: 'globalRegion must be us-east-1' });
    if (t.tier.name !== name) violations.push({ tier: name, rule: 'key-matches-tier', message: `table key "${name}" but tier.name is "${t.tier.name}"` });
  }

  const prod = entries.filter(([, t]) => t.tier.name === 'prod');
  const nonProd = entries.filter(([, t]) => t.tier.name !== 'prod');
  for (const [pName, p] of prod) {
    for (const [nName, n] of nonProd) {
      if (p.env.account === n.env.account) {
        violations.push({ tier: pName, rule: 'prod-isolation', message: `shares account ${p.env.account} with ${nName}` });
      }
    }
  }
  return violations;
}
