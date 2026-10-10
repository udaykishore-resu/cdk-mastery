import { shortHash, slugify } from '@cdk-mastery/shared';
import { validateProjectId } from '../project-factory';

export interface ProjectIdParts {
  readonly org: string;
  readonly service: string;
  readonly env: string;
  /** Salt for global uniqueness across organisations (e.g. the org's numeric id). Optional. */
  readonly salt?: string;
}

/**
 * Exercise 1 (easy): deterministic, globally-unique-enough project ids.
 *
 * Project ids are immutable, globally unique across all of Google Cloud, 6–30
 * chars, and once deleted the id is unusable for 30 days. Random suffixes
 * (`random_id`) are the usual answer, but they make the id depend on state:
 * lose the state and you cannot recompute the id. A short stable hash of the
 * parts (plus an org-specific salt) gives the same uniqueness without state.
 *
 * Layout: `<org>-<service>-<env>-<4 hex>`, truncated from the *service* if too
 * long so org and env survive.
 */
export function projectIdFor(parts: ProjectIdParts): string {
  const org = slugify(parts.org);
  const env = slugify(parts.env);
  const suffix = shortHash(`${parts.salt ?? ''}:${org}/${parts.service}/${env}`).slice(0, 4);
  // org + "-" + service + "-" + env + "-" + suffix must fit in 30 chars.
  const room = 30 - (org.length + 1 + 1 + env.length + 1 + suffix.length);
  const service = slugify(parts.service).slice(0, Math.max(1, room)).replace(/-+$/, '');
  const id = `${org}-${service}-${env}-${suffix}`;
  validateProjectId(id);
  return id;
}
