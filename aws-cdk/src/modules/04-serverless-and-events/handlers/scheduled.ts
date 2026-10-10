/**
 * EventBridge Scheduler target. The scheduler invokes the function asynchronously with the
 * `input` configured on the schedule; nothing about the schedule itself arrives in the
 * event unless you put it there (contrast with EventBridge *rules*, which send the
 * `aws.events` envelope).
 */
export interface ReportRequest {
  readonly report: string;
  readonly tier: string;
}

export async function handler(input: ReportRequest): Promise<{ generated: string; at: string }> {
  const at = new Date().toISOString();
  console.log(JSON.stringify({ level: 'info', msg: 'generating report', report: input.report, tier: input.tier, at }));
  return { generated: input.report, at };
}
