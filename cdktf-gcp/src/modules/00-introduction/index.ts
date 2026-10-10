import { App } from 'cdktf';
import { HelloStack } from './hello-stack';

export * from './hello-stack';
export * from './gcp-config';

/**
 * Module 00 contributes one stack. The id `m00-hello` becomes the directory
 * `cdktf.out/stacks/m00-hello/`, the name in `manifest.json`, the local state
 * file `terraform.m00-hello.tfstate` and the argument to `cdktf deploy m00-hello`,
 * so it is lowercase kebab on purpose.
 */
export function addToApp(app: App): void {
  new HelloStack(app, 'm00-hello', { tier: 'dev' });
}
