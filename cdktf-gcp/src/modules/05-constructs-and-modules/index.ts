import { App } from 'cdktf';
import { ConstructsStack } from './constructs-stack';

export * from './gcp-config';
export * from './secure-bucket';
export * from './pubsub-pipeline';
export * from './service-account-with-roles';
export * from './registry-network';
export * from './constructs-stack';

/** One stack, `m05-constructs`. Set `CDKM_CMEK=1` to add the KMS key and encrypt the data bucket with it. */
export function addToApp(app: App): void {
  new ConstructsStack(app, 'm05-constructs', { tier: 'dev', cmek: !!process.env.CDKM_CMEK });
}
