import { Construct } from 'constructs';
import { Project } from '@cdktf/provider-google/lib/project';
import { ProjectService } from '@cdktf/provider-google/lib/project-service';
import { enableApis } from '../project-factory';

/**
 * Exercise 2 (medium): named API bundles, so a project declares *capabilities*
 * (`['serverless', 'data']`) instead of 14 API strings copied from a wiki.
 * Bundles overlap on purpose; `enableApis` de-duplicates and orders them.
 */
export const API_BUNDLES: Record<string, readonly string[]> = {
  serverless: ['run.googleapis.com', 'cloudfunctions.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com', 'eventarc.googleapis.com', 'cloudscheduler.googleapis.com', 'vpcaccess.googleapis.com'],
  data: ['sqladmin.googleapis.com', 'servicenetworking.googleapis.com', 'bigquery.googleapis.com', 'secretmanager.googleapis.com', 'cloudkms.googleapis.com'],
  messaging: ['pubsub.googleapis.com', 'eventarc.googleapis.com'],
  observability: ['monitoring.googleapis.com', 'logging.googleapis.com', 'cloudtrace.googleapis.com'],
  gke: ['container.googleapis.com', 'artifactregistry.googleapis.com', 'compute.googleapis.com'],
};

export function resolveBundles(bundles: string[], extra: string[] = []): string[] {
  const apis: string[] = [];
  for (const bundle of bundles) {
    const list = API_BUNDLES[bundle];
    if (!list) throw new Error(`unknown API bundle "${bundle}"; known: ${Object.keys(API_BUNDLES).join(', ')}`);
    apis.push(...list);
  }
  apis.push(...extra);
  return [...new Set(apis)].sort();
}

export interface ProjectApisProps {
  readonly project: Project;
  readonly bundles: string[];
  readonly extra?: string[];
}

export class ProjectApis extends Construct {
  readonly services: ProjectService[];
  readonly apis: string[];

  constructor(scope: Construct, id: string, props: ProjectApisProps) {
    super(scope, id);
    this.apis = resolveBundles(props.bundles, props.extra);
    this.services = enableApis(this, props.project, this.apis);
  }
}
