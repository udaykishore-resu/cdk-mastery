import { App } from 'cdktf';
import { TestableStack } from './testable-stack';

export * from './gcp-config';
export * from './private-bucket';
export * from './testable-stack';
export * from './aspects-under-test';
export * from './snapshot-stabiliser';

/** One stack per tier so `cdktf diff m07-testable-prod` shows the tier-driven differences. */
export function addToApp(app: App): void {
  new TestableStack(app, 'm07-testable-dev', { tier: 'dev' });
  new TestableStack(app, 'm07-testable-prod', { tier: 'prod', stateBucket: process.env.CDKM_STATE_BUCKET });
}
