import { Construct } from 'constructs';
import { BillingBudget } from '@cdktf/provider-google/lib/billing-budget';
import { Project } from '@cdktf/provider-google/lib/project';
import { ProjectIamMember } from '@cdktf/provider-google/lib/project-iam-member';
import { ProjectService } from '@cdktf/provider-google/lib/project-service';
import { EnvironmentTier, mandatoryTags } from '@cdk-mastery/shared';

export type ProjectDeletionPolicy = 'PREVENT' | 'ABANDON' | 'DELETE';

export interface GcpProjectProps {
  /** Project id: 6–30 chars, lowercase letters/digits/hyphens, starts with a letter, globally unique, immutable. */
  readonly projectId: string;
  readonly displayName?: string;
  /** Numeric folder id (`Folder.folderId`). */
  readonly folderId: string;
  readonly billingAccount: string;
  readonly tier: EnvironmentTier;
  /** Workload name for labels. */
  readonly service: string;
  /** APIs to enable, e.g. `run.googleapis.com`. Order in the list is irrelevant; see `enableApis`. */
  readonly apis: string[];
  /**
   * `PREVENT` (provider default) makes `terraform destroy` fail; `DELETE` deletes
   * the project (30-day recovery window, billing stops immediately); `ABANDON`
   * drops it from state and leaves it running. Derived from the tier when unset:
   * prod -> PREVENT, everything else -> DELETE.
   */
  readonly deletionPolicy?: ProjectDeletionPolicy;
  /** Role -> groups. Only `group:` principals are accepted (people never get direct project IAM). */
  readonly groupRoles?: Record<string, string[]>;
  /** Monthly budget in USD; thresholds at 50/90% actual and 100% forecast. */
  readonly monthlyBudgetUsd?: number;
  /** Monitoring notification channel ids for budget alerts (optional). */
  readonly budgetNotificationChannels?: string[];
}

/** APIs every project needs before any other API can be enabled or any IAM set. */
export const BASE_APIS = ['cloudresourcemanager.googleapis.com', 'serviceusage.googleapis.com', 'iam.googleapis.com', 'cloudbilling.googleapis.com'];

/**
 * The project factory: one construct = one project with its APIs, group IAM
 * and budget. This is the unit a landing zone stamps out per workload × env.
 */
export class GcpProject extends Construct {
  readonly project: Project;
  readonly services: ProjectService[];
  readonly budget?: BillingBudget;

  constructor(scope: Construct, id: string, props: GcpProjectProps) {
    super(scope, id);
    validateProjectId(props.projectId);

    this.project = new Project(this, 'Project', {
      projectId: props.projectId,
      name: props.displayName ?? props.projectId,
      folderId: props.folderId,
      billingAccount: props.billingAccount,
      // The default network is a flat /20-per-region auto-mode VPC with
      // allow-all-internal firewall rules. Nobody wants it; deleting it later
      // requires compute.googleapis.com to be enabled first, so never create it.
      autoCreateNetwork: false,
      labels: mandatoryTags(props.tier, props.service),
      deletionPolicy: props.deletionPolicy ?? (props.tier.retainStatefulResources ? 'PREVENT' : 'DELETE'),
    });

    this.services = enableApis(this, this.project, [...BASE_APIS, ...props.apis]);

    for (const [role, groups] of Object.entries(props.groupRoles ?? {})) {
      for (const group of groups) {
        if (!group.startsWith('group:')) {
          throw new Error(`GcpProject ${id}: IAM principals must be groups (got "${group}"); add people to the group instead`);
        }
        new ProjectIamMember(this, `Iam${pascal(role)}${pascal(group.slice('group:'.length))}`, {
          project: this.project.projectId,
          role,
          member: group,
          // IAM on a fresh project races the resourcemanager API enablement.
          dependsOn: [this.services[0]],
        });
      }
    }

    if (props.monthlyBudgetUsd !== undefined) {
      this.budget = new BillingBudget(this, 'Budget', {
        billingAccount: props.billingAccount,
        displayName: `${props.projectId} monthly`,
        budgetFilter: { projects: [`projects/${this.project.number}`], creditTypesTreatment: 'INCLUDE_ALL_CREDITS' },
        amount: { specifiedAmount: { currencyCode: 'USD', units: String(Math.round(props.monthlyBudgetUsd)) } },
        thresholdRules: [
          { thresholdPercent: 0.5 },
          { thresholdPercent: 0.9 },
          { thresholdPercent: 1.0, spendBasis: 'FORECASTED_SPEND' },
        ],
        allUpdatesRule: props.budgetNotificationChannels
          ? { monitoringNotificationChannels: props.budgetNotificationChannels, disableDefaultIamRecipients: true }
          : undefined,
      });
    }
  }
}

/**
 * Enable APIs in a dependency-respecting order.
 *
 * `google_project_service` calls are not atomic across a list: enabling
 * `run.googleapis.com` before `serviceusage.googleapis.com` is enabled fails with
 * a permission error that looks like IAM but is not. So: the base APIs first
 * (each depending on the previous, serialising them), then every other API
 * depending on the *last* base API. Terraform still parallelises the second
 * group (default -parallelism=10), which the Service Usage API tolerates.
 *
 * `disableOnDestroy: false` on every service: disabling an API on destroy tears
 * down *every resource behind it* (all Cloud Run services, all buckets' access…)
 * and the provider will happily do that in the wrong order. Leave APIs enabled;
 * the project's own deletion (or not) is the lifecycle boundary.
 */
export function enableApis(scope: Construct, project: Project, apis: string[]): ProjectService[] {
  const unique = [...new Set(apis)];
  const base = BASE_APIS.filter((a) => unique.includes(a));
  const rest = unique.filter((a) => !BASE_APIS.includes(a));
  const out: ProjectService[] = [];
  let previous: ProjectService | undefined;
  for (const api of base) {
    previous = new ProjectService(scope, `Api${pascal(api)}`, {
      project: project.projectId,
      service: api,
      disableOnDestroy: false,
      dependsOn: previous ? [previous] : undefined,
    });
    out.push(previous);
  }
  const gate = previous;
  for (const api of rest) {
    out.push(
      new ProjectService(scope, `Api${pascal(api)}`, {
        project: project.projectId,
        service: api,
        disableOnDestroy: false,
        dependsOn: gate ? [gate] : undefined,
      }),
    );
  }
  return out;
}

export function validateProjectId(projectId: string): void {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new Error(`invalid project id "${projectId}": 6-30 chars, lowercase letters, digits, hyphens; must start with a letter and not end with a hyphen`);
  }
  if (/^(google|ssl|null|undefined)/.test(projectId) || projectId.includes('goog')) {
    throw new Error(`invalid project id "${projectId}": reserved word`);
  }
}

/** `run.googleapis.com` -> `RunGoogleapisCom`; `roles/viewer` -> `RolesViewer`; `sre@example.com` -> `SreExampleCom`. */
export function pascal(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}
