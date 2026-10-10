import { Fn, Token } from 'cdktf';
import { Construct } from 'constructs';
import { DataGoogleProject } from '@cdktf/provider-google/lib/data-google-project';
import { DataGoogleClientConfig } from '@cdktf/provider-google/lib/data-google-client-config';
import { DataGoogleComputeZones } from '@cdktf/provider-google/lib/data-google-compute-zones';

export interface ProjectFactsProps {
  readonly region: string;
}

/**
 * Data sources: read-only lookups Terraform performs at *plan* time.
 *
 * A resource says "make this exist"; a data source says "tell me about this".
 * Both live in state (data sources are refreshed every plan), both produce
 * attributes, and the attributes of both are tokens until apply. The three
 * below are the ones almost every GCP stack needs:
 *
 *   google_project        -> the project *number*, which IAM bindings for Google-
 *                            managed service agents need (service-<number>@...).
 *   google_client_config  -> what the provider resolved: project, region, zone, and
 *                            an OAuth access token (for kubernetes/helm providers).
 *   google_compute_zones  -> the UP zones of a region, so you never hard-code "-a".
 */
export class ProjectFacts extends Construct {
  readonly project: DataGoogleProject;
  readonly client: DataGoogleClientConfig;
  readonly zones: DataGoogleComputeZones;

  /** Project number as a string token, e.g. for `serviceAccount:service-${number}@...`. */
  readonly projectNumber: string;
  /** First UP zone of the region, e.g. `us-central1-a`, as a token. */
  readonly firstZone: string;
  /** Zone names as a list token; `Token.asList` lets TypeScript treat it as `string[]`. */
  readonly zoneNames: string[];
  /** `length(...)` as a number token; `Token.asNumber` lets TypeScript treat an expression as `number`. */
  readonly zoneCount: number;

  constructor(scope: Construct, id: string, props: ProjectFactsProps) {
    super(scope, id);
    this.project = new DataGoogleProject(this, 'Project');
    this.client = new DataGoogleClientConfig(this, 'Client');
    this.zones = new DataGoogleComputeZones(this, 'Zones', { region: props.region, status: 'UP' });

    this.projectNumber = Token.asString(this.project.number);
    this.zoneNames = Token.asList(this.zones.names);
    // `zones.names[0]` would be a bug: the token is not a real array at synth time.
    // `Fn.element` renders `element(data.google_compute_zones.Zones.names, 0)` and
    // lets Terraform index the real list at plan time.
    this.firstZone = Fn.element(this.zones.names, 0);
    this.zoneCount = Token.asNumber(Fn.lengthOf(this.zones.names));
  }
}
