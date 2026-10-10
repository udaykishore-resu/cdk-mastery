import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { GITHUB_OIDC_AUDIENCE, GITHUB_OIDC_ISSUER } from '../github-oidc-stack';

export interface SplitOidcRolesProps {
  readonly repo: string;
  readonly provider: iam.IOidcProvider;
  readonly qualifier?: string;
}

/**
 * Exercise 3 — least privilege per workflow trigger.
 *
 * A single deploy role that PR workflows can assume means any contributor who can
 * open a PR (and, with `pull_request_target`, even a fork) gets deploy rights.
 * Split by `sub` claim:
 *
 *   DiffRole   — sub = repo:o/r:pull_request       → may assume *lookup* + *deploy* roles
 *                (deploy role only for read APIs: cdk diff needs GetTemplate; the
 *                bootstrap deploy role has no write permissions itself — writes
 *                happen through the CFN execution role, which only CloudFormation
 *                can assume — but still: separate role, separate audit trail).
 *   DeployRole — sub = repo:o/r:ref:refs/heads/main (and environment:prod)
 *                → may assume all four bootstrap roles.
 *
 * The important asymmetry is on the *trust* side: the PR role's `sub` pattern
 * matches only pull-request tokens; the main role's matches only main/prod.
 */
export class SplitOidcRoles extends Construct {
  readonly diffRole: iam.Role;
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: SplitOidcRolesProps) {
    super(scope, id);
    const qualifier = props.qualifier ?? cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER;
    const bootstrapRoleArn = `arn:${cdk.Aws.PARTITION}:iam::*:role/cdk-${qualifier}-*-role-*`;

    const principalFor = (subjects: string[]) =>
      new iam.WebIdentityPrincipal(props.provider.oidcProviderArn, {
        StringEquals: { [`${GITHUB_OIDC_ISSUER}:aud`]: GITHUB_OIDC_AUDIENCE },
        StringLike: { [`${GITHUB_OIDC_ISSUER}:sub`]: subjects },
      });

    this.diffRole = new iam.Role(this, 'DiffRole', {
      roleName: `github-diff-${props.repo.replace('/', '-')}`,
      assumedBy: principalFor([`repo:${props.repo}:pull_request`]),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    this.diffRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeReadBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [bootstrapRoleArn],
        conditions: { StringEquals: { 'iam:ResourceTag/aws-cdk:bootstrap-role': ['lookup', 'deploy'] } },
      }),
    );

    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: `github-deploy-${props.repo.replace('/', '-')}`,
      assumedBy: principalFor([`repo:${props.repo}:ref:refs/heads/main`, `repo:${props.repo}:environment:prod`]),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeAllBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [bootstrapRoleArn],
        conditions: { StringEquals: { 'iam:ResourceTag/aws-cdk:bootstrap-role': ['deploy', 'file-publishing', 'image-publishing', 'lookup'] } },
      }),
    );
  }
}
