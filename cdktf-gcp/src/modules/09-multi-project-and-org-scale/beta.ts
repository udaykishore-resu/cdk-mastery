import { Construct } from 'constructs';
import { GoogleBetaProvider } from '@cdktf/provider-google-beta/lib/provider';
import { GoogleProjectServiceIdentity } from '@cdktf/provider-google-beta/lib/google-project-service-identity';
import { ITerraformDependable } from 'cdktf';
import { pascal } from './project-factory';

/**
 * google-beta usage for a resource the GA provider does not have.
 *
 * `google_project_service_identity` exists only in `google-beta` (verified:
 * there is no `project-service-identity` under @cdktf/provider-google/lib).
 * It forces creation of a service's *service agent* — the Google-managed SA
 * such as `service-<num>@serverless-robot-prod.iam.gserviceaccount.com` for
 * Cloud Run, or `service-<num>@gcp-sa-cloud-sql.iam.gserviceaccount.com` for
 * Cloud SQL — and returns its email. Normally the agent is created lazily on
 * first use of the API, which means the IAM grant it needs (a KMS key for CMEK,
 * a Shared VPC subnet for private IP) cannot be made in the same apply as the
 * resource that needs it: the principal does not exist yet. This resource
 * closes the gap so a fresh project works in one `cdktf deploy`.
 *
 * Every beta class is prefixed `Google` and needs the beta provider; a stack
 * can hold both providers, and a resource picks one with `provider:`.
 */
export interface ServiceAgentsProps {
  readonly project: string;
  readonly region: string;
  /** APIs whose agents to materialise, e.g. `run.googleapis.com`, `sqladmin.googleapis.com`. */
  readonly services: string[];
  readonly dependsOn?: ITerraformDependable[];
}

export class ServiceAgents extends Construct {
  readonly provider: GoogleBetaProvider;
  readonly identities: Record<string, GoogleProjectServiceIdentity> = {};

  constructor(scope: Construct, id: string, props: ServiceAgentsProps) {
    super(scope, id);
    this.provider = new GoogleBetaProvider(this, 'GoogleBeta', { project: props.project, region: props.region });
    for (const service of props.services) {
      this.identities[service] = new GoogleProjectServiceIdentity(this, `Agent${pascal(service)}`, {
        provider: this.provider,
        project: props.project,
        service,
        dependsOn: props.dependsOn,
      });
    }
  }

  /** `serviceAccount:service-<num>@...` for use in IAM bindings. */
  member(service: string): string {
    const identity = this.identities[service];
    if (!identity) throw new Error(`no service agent requested for ${service}`);
    return identity.member;
  }
}
