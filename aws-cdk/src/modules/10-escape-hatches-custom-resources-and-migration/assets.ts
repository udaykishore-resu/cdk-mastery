import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';

export interface BundledConfigAssetProps {
  /** Directory with `base.json` and `overrides.json`. */
  readonly sourcePath: string;
}

/**
 * Assets are files CDK uploads to the bootstrap bucket at deploy time and
 * references from the template (`S3Bucket`/`S3Key`, or an SSM-style
 * parameter for legacy synthesizers). Three pieces:
 *
 *  - `AssetStaging` copies the source into `cdk.out/asset.<hash>/` and computes
 *    the hash (`AssetHashType.SOURCE` = hash of the input; `OUTPUT` = hash of the
 *    bundled result; `CUSTOM` = you supply it). The hash *is* the identity: same
 *    hash → nothing re-uploaded, no template change.
 *  - `BundlingOptions` transforms the source before hashing/uploading. The
 *    default runs a Docker container (`image`); `local.tryBundle()` gets first
 *    refusal and, if it returns true, Docker is never touched. This repo has no
 *    Docker, so local bundling is the only path that works — the `image` prop is
 *    still required by the type and would only be used if `tryBundle` returned false.
 *  - `s3_assets.Asset` wraps both and exposes `s3BucketName`, `s3ObjectKey`,
 *    `s3ObjectUrl`, `assetHash`, plus `grantRead`.
 *
 * Lambda `Code.fromAsset`, `ContainerImage.fromAsset` and `aws-s3-deployment`
 * all sit on the same three pieces.
 */
export class BundledConfigAsset extends Construct {
  readonly asset: s3_assets.Asset;

  constructor(scope: Construct, id: string, props: BundledConfigAssetProps) {
    super(scope, id);

    this.asset = new s3_assets.Asset(this, 'Asset', {
      path: props.sourcePath,
      // The hash is computed over the *output* directory, so a change in either
      // input file, or in the merge logic below, changes the key.
      assetHashType: cdk.AssetHashType.OUTPUT,
      bundling: {
        image: cdk.DockerImage.fromRegistry('public.ecr.aws/docker/library/node:22-alpine'), // never pulled: local wins
        command: ['sh', '-c', 'node /asset-input/merge.js > /asset-output/config.json'], // the Docker fallback, for completeness
        local: {
          tryBundle(outputDir: string): boolean {
            const base = JSON.parse(fs.readFileSync(path.join(props.sourcePath, 'base.json'), 'utf8')) as Record<string, unknown>;
            const overrides = JSON.parse(fs.readFileSync(path.join(props.sourcePath, 'overrides.json'), 'utf8')) as Record<string, unknown>;
            const merged = deepMerge(base, overrides);
            fs.writeFileSync(path.join(outputDir, 'config.json'), JSON.stringify(merged, null, 2));
            return true; // "I did it; do not run Docker"
          },
        },
      },
    });
  }
}

export function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const existing = out[k];
    out[k] = isPlainObject(existing) && isPlainObject(v) ? deepMerge(existing, v) : v;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
