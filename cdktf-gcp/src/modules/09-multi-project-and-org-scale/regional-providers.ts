import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { regionShortCode } from '@cdk-mastery/shared';

/**
 * Per-region provider aliases.
 *
 * The Google provider's `region` is only a *default* for regional resources
 * that omit `region`; most resources accept an explicit `region`/`location`
 * argument, so aliases are rarely *required* on GCP the way they are on AWS.
 * They still earn their place when:
 *   - a resource has no `region` argument and takes it from the provider
 *     (`google_compute_router` does; some data sources do);
 *   - you want `cdktf diff` to show `provider = google.eu` on every EU resource
 *     as a review cue;
 *   - the regions are in different *projects* (Shared VPC host in one, regional
 *     workloads in another): then the alias carries the project too.
 *
 * Only one provider of a type may be un-aliased per stack; every other one
 * needs `alias`. Resources pick one with `provider: providers.eu`.
 */
export interface RegionalProvidersProps {
  readonly project: string;
  readonly regions: string[];
  /** Region that gets the un-aliased (default) provider. Defaults to the first. */
  readonly defaultRegion?: string;
}

export type RegionalProviders = Record<string, GoogleProvider>;

export function regionalProviders(scope: Construct, props: RegionalProvidersProps): RegionalProviders {
  const defaultRegion = props.defaultRegion ?? props.regions[0];
  const out: RegionalProviders = {};
  for (const region of props.regions) {
    const isDefault = region === defaultRegion;
    out[region] = new GoogleProvider(scope, isDefault ? 'Google' : `Google${regionShortCode(region).toUpperCase()}`, {
      project: props.project,
      region,
      alias: isDefault ? undefined : regionShortCode(region),
    });
  }
  return out;
}
