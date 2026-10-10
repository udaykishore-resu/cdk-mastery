import * as cdk from 'aws-cdk-lib';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import { GovernedStack } from './governed-stack';
import { MandatoryTagsPlugin } from './mandatory-tags-plugin';
import { applyAwsSolutionsChecks } from './nag';

export * from './aspects/construct-policy-aspect';
export * from './aspects/enforce-bucket-encryption-aspect';
export * from './aspects/log-retention-aspect';
export * from './aspects/no-public-buckets-aspect';
export * from './aspects/require-tags-aspect';
export * from './governance';
export * from './governed-stack';
export * from './mandatory-tags-plugin';
export * from './nag';
export * from './permissions-boundary';

/**
 * Module 06 entry point.
 *
 * `M06-Governed` is env-agnostic: nothing in it needs an account or region at
 * synth time (the boundary ARN is assembled from `AWS::AccountId` at deploy time).
 *
 * Validation plugins are registered on the *App*, which means they validate every
 * stack in the curriculum app, not just this module's. That is the correct
 * production shape (one gate for everything) but it would fail `cdk synth` for
 * modules that have not adopted the rules yet, so both are opt-in:
 *
 *   cdk synth -c cdk-mastery:nag=true  M06-Governed        # AwsSolutions pack
 *   cdk synth -c cdk-mastery:m06-violations=true M06-Governed   # watch the aspects fire
 */
export function addToApp(app: cdk.App): void {
  const flag = (key: string) => {
    const v = app.node.tryGetContext(key);
    return v === true || v === 'true';
  };

  new GovernedStack(app, 'M06-Governed', {
    tier: ENVIRONMENTS.dev,
    includeViolations: flag('cdk-mastery:m06-violations'),
  });

  if (flag('cdk-mastery:nag')) {
    applyAwsSolutionsChecks(app);
    cdk.Validations.of(app).addPlugins(
      new MandatoryTagsPlugin({
        requiredKeys: ['environment', 'service', 'owner', 'cost-center'],
        resourceTypes: ['AWS::S3::Bucket', 'AWS::SQS::Queue', 'AWS::Lambda::Function', 'AWS::Logs::LogGroup'],
      }),
    );
  }
}
