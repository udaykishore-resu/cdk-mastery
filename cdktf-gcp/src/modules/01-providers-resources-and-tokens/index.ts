import { App } from 'cdktf';
import { DEFAULT_BUCKETS, TokensStack } from './tokens-stack';

export * from './gcp-config';
export * from './providers';
export * from './project-facts';
export * from './tokens-stack';

export function addToApp(app: App): void {
  new TokensStack(app, 'm01-tokens', { tier: 'dev', buckets: DEFAULT_BUCKETS });
}
