import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { EnvironmentTier, PascalCaseIds, ConstructPolicy, mandatoryTags } from '@cdk-mastery/shared';
import { AwsSolutionsChecks } from 'cdk-nag';
import { IConstruct } from 'constructs';
import { SERVICE } from './config';

/**
 * Read-only aspect: every S3 bucket blocks all four public-access vectors.
 * Defined here (not imported from module 06) so the capstone is self-contained;
 * the implementation is the same shape.
 */
export class NoPublicBucketsAspect implements cdk.IAspect {
  visit(node: IConstruct): void {
    if (!cdk.CfnResource.isCfnResource(node) || node.cfnResourceType !== 'AWS::S3::Bucket') return;
    const bucket = node as s3.CfnBucket;
    const pab = cdk.Stack.of(node).resolve(bucket.publicAccessBlockConfiguration) as s3.CfnBucket.PublicAccessBlockConfigurationProperty | undefined;
    const ok = [pab?.blockPublicAcls, pab?.blockPublicPolicy, pab?.ignorePublicAcls, pab?.restrictPublicBuckets].every((f) => f === true);
    if (!ok) cdk.Annotations.of(node).addError('NoPublicBucketsAspect: all four PublicAccessBlockConfiguration flags must be true');
  }
}

const JSII_RTTI = Symbol.for('jsii.rtti');

/** True when the construct's class ships in aws-cdk-lib (every jsii class carries its fqn). */
export function isFrameworkConstruct(node: IConstruct): boolean {
  const rtti = (node.constructor as { [JSII_RTTI]?: { fqn?: string } })[JSII_RTTI];
  return typeof rtti?.fqn === 'string' && rtti.fqn.startsWith('aws-cdk-lib.');
}

/**
 * Bridge for the shared ConstructPolicy (see module 06): violations become
 * error annotations. The house rule applies to ids *we* choose, so children of
 * framework L2s are skipped — `HttpApi.addRoutes` names routes `GET--orders--{id}`
 * and `SqsEventSource` names mappings `SqsEventSource:<hash>`; those are the
 * library's business, and renaming them would change logical ids.
 */
export class PascalCaseIdsAspect implements cdk.IAspect {
  private readonly policy = new ConstructPolicy([PascalCaseIds]);
  constructor(private readonly root: IConstruct) {}
  visit(node: IConstruct): void {
    if (node === this.root) return; // `M11-Dev` is a stage id chosen by the curriculum, not a logical id
    const parent = node.node.scope;
    if (parent && !cdk.Stage.isStage(parent) && !cdk.Stack.isStack(parent) && isFrameworkConstruct(parent)) return;
    // Framework singletons are placed directly under the Stack with type-like ids
    // (`Custom::VpcRestrictDefaultSGCustomResourceProvider`, `AWS679f53fa…`); a colon never appears in an id we write.
    if (node.node.id.includes(':') && isFrameworkConstruct(node)) return;
    const before = this.policy.violations.length;
    this.policy.visit(node);
    for (const v of this.policy.violations.slice(before)) cdk.Annotations.of(node).addError(`[${v.rule}] ${v.message}`);
  }
}

/**
 * cdk-nag 3.0.2's `NagPack.validate(context)` walks `context.appConstruct` — the
 * whole App — even when the plugin was registered on a Stage. In an app with
 * several stages (or a curriculum app with twelve modules) that means one
 * stage's plugin fails synthesis for stacks it does not own. This wrapper keeps
 * the plugin contract but validates only the subtree it was created for.
 */
export class ScopedAwsSolutionsChecks implements cdk.IPolicyValidationPlugin {
  readonly name = 'AwsSolutions';
  readonly version = '3.0.2';
  private readonly pack: AwsSolutionsChecks;

  constructor(private readonly scope: IConstruct) {
    this.pack = new AwsSolutionsChecks(scope, { verbose: true });
  }

  validate(_context: cdk.IPolicyValidationContext): cdk.PolicyValidationPluginReport {
    return this.pack.validateScope(this.scope);
  }
}

/**
 * Governance is applied at the Stage, once, and reaches every stack:
 *   - mandatory tags from the shared tier model (MUTATING, via Tags)
 *   - NoPublicBuckets + PascalCaseIds validators (READONLY)
 *   - cdk-nag AwsSolutions as a validation plugin on the Stage
 *
 * Acknowledgements live next to the constructs that own the findings (see
 * `acknowledgeKnownFindings` below, called by the Stage after all stacks exist),
 * each with a reason a reviewer can evaluate. The test suite asserts the stage
 * has zero unacknowledged errors, so any new finding fails CI until it is either
 * fixed or explicitly accepted here.
 */
export function applyPlatformGovernance(stage: cdk.Stage, tier: EnvironmentTier): void {
  for (const [key, value] of Object.entries(mandatoryTags(tier, SERVICE))) cdk.Tags.of(stage).add(key, value);
  cdk.Aspects.of(stage).add(new NoPublicBucketsAspect(), { priority: cdk.AspectPriority.READONLY });
  cdk.Aspects.of(stage).add(new PascalCaseIdsAspect(stage), { priority: cdk.AspectPriority.READONLY });
  cdk.Validations.of(stage).addPlugins(new ScopedAwsSolutionsChecks(stage));
}

export interface KnownFindingsScopes {
  readonly tier: EnvironmentTier;
  readonly tableName: string;
  readonly lambdaFunctions: IConstruct[];
  readonly openRoutes: IConstruct[];
}

const LAMBDA_BASIC = 'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';
const LAMBDA_VPC = 'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole';

/**
 * Every acknowledged finding, with the reason. cdk-nag 3 ids are per finding:
 * `AwsSolutions-IAM5[Action::kms:ReEncrypt*]`. Wildcards inside the id are part
 * of the id, not patterns. The table ARN below is what cdk-nag renders after
 * flattening `Fn::Join`/`Ref` into `<...>` placeholders — deterministic because
 * consumers reference the table by name, not by export.
 */
export function acknowledgeKnownFindings(scopes: KnownFindingsScopes): void {
  const indexArn = `Resource::arn:<AWS::Partition>:dynamodb:<AWS::Region>:<AWS::AccountId>:table/${scopes.tableName}/index/*`;
  for (const fn of scopes.lambdaFunctions) {
    cdk.Validations.of(fn).acknowledge(
      { id: `AwsSolutions-IAM4[${LAMBDA_BASIC}]`, reason: 'AWSLambdaBasicExecutionRole grants CloudWatch Logs write only; an inline copy would be identical.' },
      { id: `AwsSolutions-IAM4[${LAMBDA_VPC}]`, reason: 'AWSLambdaVPCAccessExecutionRole is required for ENI management; its EC2 actions have no resource-level scoping.' },
      { id: `AwsSolutions-IAM5[${indexArn}]`, reason: 'grantReadWriteData covers the GSI with a wildcard; indexes are created and deleted with the table itself.' },
      { id: 'AwsSolutions-IAM5[Action::kms:ReEncrypt*]', reason: 'kms:ReEncrypt* is the action family DynamoDB SSE-KMS needs; the statement is scoped to the platform data key.' },
      { id: 'AwsSolutions-IAM5[Action::kms:GenerateDataKey*]', reason: 'kms:GenerateDataKey* is the action family DynamoDB SSE-KMS needs; the statement is scoped to the platform data key.' },
      { id: 'AwsSolutions-IAM5[Resource::*]', reason: 'Only the X-Ray statement (xray:PutTraceSegments/PutTelemetryRecords) uses Resource:*; X-Ray has no resource-level permissions. The test suite asserts no other statement does.' },
    );
  }
  for (const route of scopes.openRoutes) {
    cdk.Validations.of(route).acknowledge({
      id: 'AwsSolutions-APIG4',
      reason: 'GET /health is unauthenticated on purpose: load-balancer and pipeline smoke checks; it returns a constant and touches no data.',
    });
  }
}
