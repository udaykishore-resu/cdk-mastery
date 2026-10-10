import * as cdk from 'aws-cdk-lib';
import { EnvironmentTier } from '@cdk-mastery/shared';

/**
 * Qualifier per tier. Bootstrap resources (bucket, ECR repo, four roles, SSM
 * version parameter) are named `cdk-<qualifier>-...`; a distinct qualifier per
 * tier lets two bootstraps coexist in one account/region — dev and a
 * security-hardened prod with different execution policies — and lets an SCP
 * pin which qualifier's roles a pipeline may assume.
 *
 * Rules: ≤ 10 characters, `[A-Za-z0-9]`. The default is `hnb659fds`.
 */
const QUALIFIERS: Record<string, string> = { dev: 'platdev', staging: 'platstg', prod: 'platprod' };

export function qualifierFor(tier: EnvironmentTier): string {
  const q = QUALIFIERS[tier.name];
  if (!q || !/^[A-Za-z0-9]{1,10}$/.test(q)) throw new Error(`No valid bootstrap qualifier for tier ${tier.name}`);
  return q;
}

/**
 * A `DefaultStackSynthesizer` bound to the tier's bootstrap.
 *
 * The synthesizer decides *where assets go* and *which roles the CLI/pipeline
 * assume*. Every template it produces carries a `BootstrapVersion` parameter
 * pointing at `/cdk-bootstrap/<qualifier>/version`, and the cloud assembly's
 * manifest records the deploy/lookup/publishing role ARNs — the CLI reads those,
 * it does not compute them. The `${Qualifier}` / `${AWS::AccountId}` /
 * `${AWS::Region}` placeholders are substituted by the synthesizer, not by CFN.
 *
 * Matching bootstrap command (run once per account/region, from an admin role):
 *
 *   npx cdk bootstrap aws://222222222222/us-west-2 \
 *     --qualifier platprod \
 *     --trust 111111111111 \
 *     --cloudformation-execution-policies arn:aws:iam::222222222222:policy/cdk-exec-prod \
 *     --toolkit-stack-name CDKToolkit-platprod
 *
 * `--trust` = the account allowed to assume the deploy/publishing roles (the
 * pipeline account). `--cloudformation-execution-policies` = what CloudFormation
 * itself may do; AdministratorAccess is the quick start, a scoped policy is prod.
 */
export function platformSynthesizer(tier: EnvironmentTier): cdk.DefaultStackSynthesizer {
  return new cdk.DefaultStackSynthesizer({
    qualifier: qualifierFor(tier),
    // The defaults below are shown explicitly so the naming contract is visible;
    // only `qualifier` is strictly needed for the standard bootstrap template.
    fileAssetsBucketName: 'cdk-${Qualifier}-assets-${AWS::AccountId}-${AWS::Region}',
    imageAssetsRepositoryName: 'cdk-${Qualifier}-container-assets-${AWS::AccountId}-${AWS::Region}',
    deployRoleArn: 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-${Qualifier}-deploy-role-${AWS::AccountId}-${AWS::Region}',
    cloudFormationExecutionRole: 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-${Qualifier}-cfn-exec-role-${AWS::AccountId}-${AWS::Region}',
    fileAssetPublishingRoleArn: 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-${Qualifier}-file-publishing-role-${AWS::AccountId}-${AWS::Region}',
    imageAssetPublishingRoleArn: 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-${Qualifier}-image-publishing-role-${AWS::AccountId}-${AWS::Region}',
    lookupRoleArn: 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-${Qualifier}-lookup-role-${AWS::AccountId}-${AWS::Region}',
    bootstrapStackVersionSsmParameter: '/cdk-bootstrap/${Qualifier}/version',
    // Keep the version rule: it is the guard that fails a deploy early when the
    // environment was bootstrapped with an older template than the app expects.
    generateBootstrapVersionRule: true,
  });
}
