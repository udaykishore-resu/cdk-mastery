import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface DeveloperBoundaryProps {
  /** Name used for the managed policy; must be stable because SCPs reference it by ARN. */
  readonly policyName: string;
}

/**
 * A permissions boundary is the *ceiling* on what any role created by this app
 * can do, no matter what inline policies `grant*` attaches later. It is the
 * standard answer to "developers may create IAM roles, but never one that can
 * escalate": an SCP in the org requires `iam:CreateRole` calls to carry
 * `iam:PermissionsBoundary = <this ARN>`, and this construct makes every CDK role
 * comply automatically.
 *
 * Applied with `iam.PermissionsBoundary.of(scope).apply(policy)`, which is —
 * again — an aspect under the hood: it visits every `CfnRole`/`CfnUser` in scope
 * and sets `PermissionsBoundary`. The one applied *closest* to the role wins, so a
 * stack can tighten (never loosen, because the policy itself is the ceiling) the
 * platform default.
 */
export class DeveloperBoundary extends Construct {
  readonly policy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: DeveloperBoundaryProps) {
    super(scope, id);
    this.policy = new iam.ManagedPolicy(this, 'Policy', {
      managedPolicyName: props.policyName,
      description: 'Permissions boundary: allows workload services, denies IAM escalation',
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowWorkloadServices',
          effect: iam.Effect.ALLOW,
          actions: ['s3:*', 'dynamodb:*', 'sqs:*', 'sns:*', 'logs:*', 'lambda:*', 'kms:*', 'ssm:GetParameter*', 'xray:*', 'events:*', 'states:*'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'DenyBoundaryEscape',
          effect: iam.Effect.DENY,
          // A role that could create roles *without* this boundary, or edit the
          // boundary policy itself, could escape. Deny both explicitly.
          actions: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary', 'iam:DeleteRolePermissionsBoundary', 'iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:SetDefaultPolicyVersion'],
          resources: ['*'],
        }),
      ],
    });
  }

  /** Apply this boundary to every IAM role and user beneath `scope`. */
  applyTo(scope: Construct): void {
    iam.PermissionsBoundary.of(scope).apply(this.policy);
  }
}

/**
 * When the boundary policy is owned by the security team and already exists,
 * import it by name. No CFN resource is created; the ARN is assembled from the
 * current stack's partition and account.
 */
export function importBoundary(scope: Construct, policyName: string): iam.IManagedPolicy {
  return iam.ManagedPolicy.fromManagedPolicyName(scope, 'ImportedBoundary', policyName);
}

/** Convenience: apply an imported boundary to a whole stack. */
export function applyImportedBoundary(stack: cdk.Stack, policyName: string): void {
  iam.PermissionsBoundary.of(stack).apply(importBoundary(stack, policyName));
}
