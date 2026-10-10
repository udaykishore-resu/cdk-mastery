import { EnvironmentTier } from '@cdk-mastery/shared';
import { sizingFor } from '../config';

/**
 * Exercise 2 — a cost model that reads the same `sizingFor(tier)` the stacks read.
 *
 * The point is not the dollar figures (list prices drift; these are us-east-1
 * on-demand numbers from 2026 and are deliberately rounded) but the *shape*:
 * which lines are fixed (you pay them at zero traffic) and which scale with
 * usage. A platform engineer should be able to say "dev costs $X a month idle,
 * and the first $Y of that is NAT" without opening the billing console.
 *
 * Every line cites the sizing knob or the resource that drives it.
 */
export const CostModel = {
  natGatewayHourly: 0.045, // per gateway-hour, excluding data processing
  natGatewayPerGb: 0.045,
  kmsKeyMonthly: 1.0,
  kmsPer10kRequests: 0.03,
  httpApiPerMillion: 1.0, // first 300M requests
  lambdaPerMillionRequests: 0.2,
  lambdaArmGbSecond: 0.0000133,
  dynamoWritePerMillion: 1.25, // on-demand WRU
  dynamoReadPerMillion: 0.25, // on-demand RRU
  dynamoStoragePerGb: 0.25,
  dynamoPitrPerGb: 0.2,
  sqsPerMillion: 0.4, // after the free tier
  eventBridgePerMillion: 1.0,
  cloudWatchAlarmStandard: 0.1, // per alarm-month; composite alarms are $0.50
  cloudWatchCompositeAlarm: 0.5,
  cloudWatchDashboard: 3.0, // per dashboard-month beyond the free three
  logsIngestPerGb: 0.5,
  logsStoragePerGbMonth: 0.03,
  hoursPerMonth: 730,
} as const;

export interface UsageProfile {
  /** HTTP API requests per month (every one invokes the API Lambda). */
  readonly requestsPerMonth: number;
  /** Orders created per month (each is one EventBridge event, one SQS message, one worker invocation, two DynamoDB writes). */
  readonly ordersPerMonth: number;
  /** Data at rest in DynamoDB, GB. */
  readonly storedGb: number;
}

export interface CostLine {
  readonly item: string;
  readonly usd: number;
  readonly kind: 'fixed' | 'usage';
  readonly drivenBy: string;
}

export interface CostEstimate {
  readonly tier: string;
  readonly lines: CostLine[];
  readonly fixed: number;
  readonly usage: number;
  readonly total: number;
}

export function estimateMonthlyCost(tier: EnvironmentTier, usage: UsageProfile): CostEstimate {
  const s = sizingFor(tier);
  const M = 1_000_000;
  const h = CostModel.hoursPerMonth;

  // Rough per-invocation duration assumptions; the API is fast, the worker does a couple of table writes.
  const apiGbSeconds = (usage.requestsPerMonth * 0.15 * s.apiMemoryMb) / 1024;
  const workerGbSeconds = ((usage.ordersPerMonth / 10) * 0.5 * s.workerMemoryMb) / 1024; // batches of 10
  const logGb = (usage.requestsPerMonth * 0.6 + usage.ordersPerMonth * 0.4) / M; // ~0.6 KB/request access log + Lambda logs

  const lines: CostLine[] = [
    { item: 'NAT gateways', usd: s.natGateways * CostModel.natGatewayHourly * h, kind: 'fixed', drivenBy: `sizingFor(tier).natGateways = ${s.natGateways}` },
    { item: 'KMS key', usd: CostModel.kmsKeyMonthly, kind: 'fixed', drivenBy: 'DataStack.key (one CMK per tier)' },
    { item: 'CloudWatch alarms', usd: 5 * CostModel.cloudWatchAlarmStandard + CostModel.cloudWatchCompositeAlarm, kind: 'fixed', drivenBy: 'ObservabilityStack: 5 alarms + 1 composite' },
    { item: 'CloudWatch dashboard', usd: CostModel.cloudWatchDashboard, kind: 'fixed', drivenBy: 'ObservabilityStack.dashboard (free if you have ≤3 in the account)' },
    { item: 'DynamoDB PITR', usd: s.pointInTimeRecovery ? usage.storedGb * CostModel.dynamoPitrPerGb : 0, kind: 'fixed', drivenBy: `sizingFor(tier).pointInTimeRecovery = ${s.pointInTimeRecovery}` },
    { item: 'DynamoDB storage', usd: usage.storedGb * CostModel.dynamoStoragePerGb, kind: 'usage', drivenBy: 'usage.storedGb' },
    { item: 'HTTP API requests', usd: (usage.requestsPerMonth / M) * CostModel.httpApiPerMillion, kind: 'usage', drivenBy: 'usage.requestsPerMonth' },
    { item: 'API Lambda', usd: (usage.requestsPerMonth / M) * CostModel.lambdaPerMillionRequests + apiGbSeconds * CostModel.lambdaArmGbSecond, kind: 'usage', drivenBy: `requests × ${s.apiMemoryMb} MB × 150 ms` },
    { item: 'Worker Lambda', usd: (usage.ordersPerMonth / 10 / M) * CostModel.lambdaPerMillionRequests + workerGbSeconds * CostModel.lambdaArmGbSecond, kind: 'usage', drivenBy: `orders/10 batches × ${s.workerMemoryMb} MB × 500 ms` },
    { item: 'DynamoDB requests', usd: (usage.ordersPerMonth * 2 / M) * CostModel.dynamoWritePerMillion + (usage.requestsPerMonth / M) * CostModel.dynamoReadPerMillion, kind: 'usage', drivenBy: '2 writes/order + 1 read/request' },
    { item: 'EventBridge + SQS', usd: (usage.ordersPerMonth / M) * (CostModel.eventBridgePerMillion + 3 * CostModel.sqsPerMillion), kind: 'usage', drivenBy: '1 event + ~3 SQS API calls per order' },
    { item: 'KMS requests', usd: ((usage.ordersPerMonth * 4 + usage.requestsPerMonth) / 10_000) * CostModel.kmsPer10kRequests, kind: 'usage', drivenBy: 'SQS + DynamoDB + SNS envelope encryption (data-key caching makes this an upper bound)' },
    { item: 'Logs', usd: logGb * CostModel.logsIngestPerGb + logGb * (tier.logRetentionDays / 30) * CostModel.logsStoragePerGbMonth, kind: 'usage', drivenBy: `ingest + ${tier.logRetentionDays}-day retention` },
  ];

  const sum = (kind: CostLine['kind']) => lines.filter((l) => l.kind === kind).reduce((a, l) => a + l.usd, 0);
  const fixed = round(sum('fixed'));
  const usageTotal = round(sum('usage'));
  return { tier: tier.name, lines: lines.map((l) => ({ ...l, usd: round(l.usd) })), fixed, usage: usageTotal, total: round(fixed + usageTotal) };
}

export function renderCostTable(estimate: CostEstimate): string {
  const rows = estimate.lines.map((l) => `| ${l.item} | ${l.kind} | $${l.usd.toFixed(2)} | ${l.drivenBy} |`);
  return [
    `| Item (${estimate.tier}) | Kind | USD / month | Driven by |`,
    '|---|---|---:|---|',
    ...rows,
    `| **Fixed** | | **$${estimate.fixed.toFixed(2)}** | paid at zero traffic |`,
    `| **Usage** | | **$${estimate.usage.toFixed(2)}** | scales with the profile |`,
    `| **Total** | | **$${estimate.total.toFixed(2)}** | |`,
  ].join('\n');
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
