import { Construct } from 'constructs';
import { ProjectService } from '@cdktf/provider-google/lib/project-service';

/**
 * Enable the APIs a stack needs, in a form other resources can `dependsOn`.
 *
 * Why this is not "just click enable once": a project factory (module 09)
 * creates projects with nothing enabled, and a stack that assumes its APIs
 * are on fails on the first apply in a fresh project with a 403 that mentions
 * "has not been used in project … before or it is disabled". Declaring the
 * services makes the stack self-sufficient and documents its dependencies.
 *
 * `disableOnDestroy: false` is non-negotiable: the default (`true`) turns the
 * API off on `destroy`, which breaks every other stack in the project that
 * happens to use the same API. `disableDependentServices` likewise stays off.
 */
export class ProjectServices extends Construct {
  readonly services: ProjectService[];

  constructor(scope: Construct, id: string, apis: readonly string[]) {
    super(scope, id);
    this.services = apis.map((api) => {
      // "servicenetworking.googleapis.com" -> "Servicenetworking": a PascalCase construct id.
      const short = api.split('.')[0].replace(/[^a-z0-9]/gi, '');
      const id = short.charAt(0).toUpperCase() + short.slice(1);
      return new ProjectService(this, id, { service: api, disableOnDestroy: false, disableDependentServices: false });
    });
  }
}
