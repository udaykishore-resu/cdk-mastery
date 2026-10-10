import { EnvironmentTier } from '@cdk-mastery/shared';

/**
 * Exercise 1 (easy): a rough monthly cost model per tier, derived from the same
 * tier flags the stacks use, so the README table and the code cannot drift.
 * List prices, us-central1, September 2025, no committed-use discounts, and
 * traffic assumptions stated per line. Rough means ±30%: it is for choosing
 * between designs and for setting the budget threshold, not for invoicing.
 */
export interface CostLine {
  readonly item: string;
  readonly usd: number;
  readonly note: string;
}

export function estimateMonthlyCost(tier: EnvironmentTier): { lines: CostLine[]; total: number } {
  const prod = tier.name === 'prod';
  const ha = tier.highlyAvailable;
  const lines: CostLine[] = [
    { item: 'Cloud SQL Postgres', usd: ha ? 2 * 105 + 50 : 8 + 2, note: ha ? 'db-custom-2-7680 REGIONAL (2× instance) + 100 GB SSD + PITR logs' : 'db-f1-micro ZONAL + 10 GB' },
    { item: 'Cloud NAT', usd: 32 + (prod ? 20 : 2), note: '1 gateway ~$32 + $0.045/GB processed' },
    { item: 'Cloud Run API', usd: prod ? 55 + 30 : 3, note: prod ? 'min 1 instance always on (~$55) + request CPU' : 'scale to zero; light dev traffic' },
    { item: 'Cloud Functions worker', usd: prod ? 15 : 1, note: '256 MB, ~2M invocations/month in prod' },
    { item: 'Pub/Sub', usd: prod ? 40 : 0, note: '10 GB/day in prod ($40/TB); free tier in dev' },
    { item: 'Secret Manager + KMS', usd: prod ? 1 : 0.5, note: 'a few secret versions, one key, ~100k ops' },
    { item: 'BigQuery', usd: prod ? 25 : 0, note: 'storage + on-demand queries; first 10 GB/1 TB free' },
    { item: 'Monitoring', usd: prod ? 10 : 0, note: 'uptime checks free tier; custom logs/metrics ingestion' },
    { item: 'Logging', usd: prod ? 25 : 0, note: `retention ${tier.logRetentionDays} days; first 50 GB/month free` },
  ];
  const total = Math.round(lines.reduce((sum, l) => sum + l.usd, 0));
  return { lines, total };
}

/** Markdown table for the README. */
export function costTable(tier: EnvironmentTier): string {
  const { lines, total } = estimateMonthlyCost(tier);
  const rows = lines.map((l) => `| ${l.item} | $${l.usd.toFixed(0)} | ${l.note} |`);
  return ['| Item | USD/month | Assumption |', '|---|---|---|', ...rows, `| **Total** | **$${total}** | budget in TIER_SETTINGS sits well above this so forecast alerts fire on real anomalies |`].join('\n');
}
