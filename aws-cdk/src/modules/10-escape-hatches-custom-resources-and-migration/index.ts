import * as cdk from 'aws-cdk-lib';
import { CfnIncludeStack } from './cfn-include-stack';
import { CustomResourcesStack } from './custom-resources-stack';
import { EscapeHatchesStack } from './escape-hatches-stack';

export * from './assets';
export * from './cfn-include-stack';
export * from './custom-resources';
export * from './custom-resources-stack';
export * from './escape-hatches-stack';

/**
 * Module 10 entry point. All three stacks are env-agnostic.
 *
 *   M10-EscapeHatches   — the ladder: defaultChild, overrides, tryRemoveChild, overrideLogicalId, raw CfnResource
 *   M10-LegacyInclude   — cloudformation-include over legacy-template.json + a CDK consumer
 *   M10-CustomResources — Provider framework (onEvent + isComplete), AwsCustomResource, bundled asset
 *
 * Migration commands worth keeping next to the code (details in README):
 *   npx cdk import M10-EscapeHatches                 # adopt orders-legacy-assets into LegacyAssetsBucket
 *   npx cdk migrate --stack-name legacy-orders --from-stack --language typescript
 *   npx cdk refactor --unstable=refactor --dry-run   # preview logical-id moves (preview feature)
 */
export function addToApp(app: cdk.App): void {
  new EscapeHatchesStack(app, 'M10-EscapeHatches');
  new CfnIncludeStack(app, 'M10-LegacyInclude', { environment: 'dev' });
  new CustomResourcesStack(app, 'M10-CustomResources');
}
