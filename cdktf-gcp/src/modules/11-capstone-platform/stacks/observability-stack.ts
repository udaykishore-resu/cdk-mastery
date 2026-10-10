import { Fn, TerraformOutput } from 'cdktf';
import { Construct } from 'constructs';
import { BillingBudget } from '@cdktf/provider-google/lib/billing-budget';
import { DataGoogleProject } from '@cdktf/provider-google/lib/data-google-project';
import { MonitoringAlertPolicy } from '@cdktf/provider-google/lib/monitoring-alert-policy';
import { MonitoringNotificationChannel } from '@cdktf/provider-google/lib/monitoring-notification-channel';
import { MonitoringUptimeCheckConfig } from '@cdktf/provider-google/lib/monitoring-uptime-check-config';
import { PlatformContext, PlatformStack } from '../platform-stack';
import { ComputeStack } from './compute-stack';
import { MessagingStack } from './messaging-stack';

export interface ObservabilityStackProps {
  readonly ctx: PlatformContext;
  readonly compute: ComputeStack;
  readonly messaging: MessagingStack;
  /** Where alerts go. `tier.owner` is a team name; this is the address. */
  readonly alertEmail: string;
  readonly billingAccount: string;
  readonly monthlyBudgetUsd: number;
}

/**
 * `m11-<env>-observability`: the three alerts that matter for this platform
 * (API 5xx rate, dead-letter depth, and — prod only — the API being down as
 * seen from outside), the channel they notify, and the budget.
 *
 * Alert thresholds are tier-driven: dev pages nobody (email only, lenient);
 * prod is strict. The uptime check exists only in prod: its checkers come
 * from outside the VPC and the dev API is internal-only anyway.
 */
export class ObservabilityStack extends PlatformStack {
  readonly channel: MonitoringNotificationChannel;
  readonly apiErrors: MonitoringAlertPolicy;
  readonly dlqDepth: MonitoringAlertPolicy;
  readonly uptime?: MonitoringUptimeCheckConfig;
  readonly budget: BillingBudget;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props.ctx);
    const { tier, project } = this.ctx;
    const prod = tier.name === 'prod';
    const current = new DataGoogleProject(this, 'Current', { projectId: project });

    this.channel = new MonitoringNotificationChannel(this, 'OnCallEmail', {
      displayName: `${tier.owner} (${tier.name})`,
      type: 'email',
      labels: { email_address: props.alertEmail }, // channel *config*, not resource labels
      userLabels: this.labels,
    });

    // Cloud Run 5xx: request rate with response_code_class = 5xx, summed over
    // the service, above N req/s for 5 minutes. Rate, not count: a busy prod
    // service at 0.1% errors still trips a count threshold.
    this.apiErrors = new MonitoringAlertPolicy(this, 'ApiErrors', {
      displayName: `[${tier.name}] orders-api 5xx rate`,
      combiner: 'OR',
      severity: prod ? 'CRITICAL' : 'WARNING',
      notificationChannels: [this.channel.name],
      userLabels: this.labels,
      conditions: [
        {
          displayName: '5xx per second',
          conditionThreshold: {
            filter: [
              'metric.type = "run.googleapis.com/request_count"',
              'resource.type = "cloud_run_revision"',
              `resource.labels.service_name = "${props.compute.api.name}"`, // cross-stack
              'metric.labels.response_code_class = "5xx"',
            ].join(' AND '),
            aggregations: [{ alignmentPeriod: '60s', perSeriesAligner: 'ALIGN_RATE', crossSeriesReducer: 'REDUCE_SUM', groupByFields: ['resource.labels.service_name'] }],
            comparison: 'COMPARISON_GT',
            thresholdValue: prod ? 0.5 : 5,
            duration: '300s',
            trigger: { count: 1 },
          },
        },
      ],
      alertStrategy: { autoClose: '1800s' },
      documentation: {
        content: `Orders API is returning 5xx. Runbook: check the latest revision (\`gcloud run revisions list --service ${props.compute.api.name}\`), Cloud SQL connectivity, and the DB password secret version.`,
        mimeType: 'text/markdown',
      },
    });

    // DLQ depth: any undelivered message on the dead-letter subscription for
    // 10 minutes means the worker gave up on something.
    this.dlqDepth = new MonitoringAlertPolicy(this, 'DeadLetterDepth', {
      displayName: `[${tier.name}] orders dead-letter queue not empty`,
      combiner: 'OR',
      severity: prod ? 'ERROR' : 'WARNING',
      notificationChannels: [this.channel.name],
      userLabels: this.labels,
      conditions: [
        {
          displayName: 'undelivered messages on the DLQ subscription',
          conditionThreshold: {
            filter: [
              'metric.type = "pubsub.googleapis.com/subscription/num_undelivered_messages"',
              'resource.type = "pubsub_subscription"',
              `resource.labels.subscription_id = "${props.messaging.deadLetterSub.name}"`, // cross-stack
            ].join(' AND '),
            aggregations: [{ alignmentPeriod: '60s', perSeriesAligner: 'ALIGN_MAX' }],
            comparison: 'COMPARISON_GT',
            thresholdValue: 0,
            duration: '600s',
          },
        },
      ],
      alertStrategy: { autoClose: '86400s' },
    });

    if (prod) {
      this.uptime = new MonitoringUptimeCheckConfig(this, 'ApiUptime', {
        displayName: '[prod] orders-api /healthz',
        timeout: '10s',
        period: '60s',
        httpCheck: {
          path: '/healthz',
          port: 443,
          useSsl: true,
          validateSsl: true,
          acceptedResponseStatusCodes: [{ statusClass: 'STATUS_CLASS_2XX' }],
        },
        monitoredResource: {
          type: 'uptime_url',
          // api.uri is https://<host>; the resource wants the host.
          labels: { host: Fn.replace(props.compute.api.uri, 'https://', ''), project_id: project },
        },
        userLabels: this.labels,
      });
      new MonitoringAlertPolicy(this, 'ApiDown', {
        displayName: '[prod] orders-api down',
        combiner: 'OR',
        severity: 'CRITICAL',
        notificationChannels: [this.channel.name],
        userLabels: this.labels,
        conditions: [
          {
            displayName: 'uptime check failing from 2+ regions',
            conditionThreshold: {
              filter: `metric.type = "monitoring.googleapis.com/uptime_check/check_passed" AND resource.type = "uptime_url" AND metric.labels.check_id = "${this.uptime.uptimeCheckId}"`,
              aggregations: [{ alignmentPeriod: '300s', perSeriesAligner: 'ALIGN_NEXT_OLDER', crossSeriesReducer: 'REDUCE_COUNT_FALSE', groupByFields: ['resource.labels.*'] }],
              comparison: 'COMPARISON_GT',
              thresholdValue: 1,
              duration: '300s',
            },
          },
        ],
      });
    }

    this.budget = new BillingBudget(this, 'Budget', {
      billingAccount: props.billingAccount,
      displayName: `orders ${tier.name} monthly`,
      budgetFilter: { projects: [`projects/${current.number}`], labels: { environment: tier.name } },
      amount: { specifiedAmount: { currencyCode: 'USD', units: String(props.monthlyBudgetUsd) } },
      thresholdRules: [{ thresholdPercent: 0.5 }, { thresholdPercent: 0.9 }, { thresholdPercent: 1.0, spendBasis: 'FORECASTED_SPEND' }],
      allUpdatesRule: { monitoringNotificationChannels: [this.channel.name], disableDefaultIamRecipients: true },
    });

    new TerraformOutput(this, 'NotificationChannel', { value: this.channel.name });
  }
}
