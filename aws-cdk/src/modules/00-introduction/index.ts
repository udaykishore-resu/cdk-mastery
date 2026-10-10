import * as cdk from 'aws-cdk-lib';
import { HelloStack } from './hello-stack';

export * from './hello-stack';
export * from './lifecycle-phases';

/**
 * Module 00 contributes one env-agnostic stack. No `env` is passed on purpose:
 * the README explains what that does to `Stack.of(this).region` and to the
 * manifest's `environment` field (`aws://unknown-account/unknown-region`).
 */
export function addToApp(app: cdk.App): void {
  new HelloStack(app, 'M00-Hello', {
    tier: 'dev',
    description: 'cdk-mastery module 00: the construct tree, the synth lifecycle and cdk.out',
  });
}
