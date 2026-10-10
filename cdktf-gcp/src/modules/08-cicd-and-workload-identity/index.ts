import { App } from 'cdktf';
import { BackendDemoStack } from './backend-demo-stack';
import { WifStack } from './wif-stack';

export * from './gcp-config';
export * from './deployer-roles';
export * from './wif-stack';
export * from './backend';
export * from './backend-demo-stack';

/**
 * `m08-wif` is a bootstrap stack: it is applied once, by a human with owner
 * rights, *before* any pipeline exists, because it creates the identity the
 * pipeline runs as. Its state should still live in GCS (the same bucket it
 * creates — chicken-and-egg solved by `cdktf deploy` with a local backend first,
 * then migrating state; see the README runbook).
 */
export function addToApp(app: App): void {
  new WifStack(app, 'm08-wif', {
    githubOwner: process.env.CDKM_GITHUB_OWNER ?? 'example-org',
    githubRepo: process.env.CDKM_GITHUB_REPO ?? 'cdk-mastery',
    stateBucket: process.env.CDKM_STATE_BUCKET ? { name: process.env.CDKM_STATE_BUCKET, create: true } : undefined,
  });
  new BackendDemoStack(app, 'm08-backend-demo', { tier: 'dev' });
}
