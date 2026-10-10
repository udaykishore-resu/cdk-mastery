import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export const GITHUB_OIDC_ISSUER = 'token.actions.githubusercontent.com';
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';

export interface GitHubOidcStackProps extends cdk.StackProps {
  /** `owner/repo` — the `sub` claim is `repo:<owner/repo>:<ref-or-environment>`. */
  readonly repo: string;
  /** Branches allowed to assume the deploy role (refs/heads/<branch>). */
  readonly deployBranches: string[];
  /** GitHub *environments* (the ones with required reviewers) allowed to deploy. */
  readonly deployEnvironments?: string[];
  /** Bootstrap qualifier whose roles this role may assume. */
  readonly qualifier?: string;
  /**
   * Set when the IAM OIDC provider for GitHub already exists in the account
   * (there can be only one per issuer URL). The stack then imports it.
   */
  readonly existingProviderArn?: string;
}

/**
 * Everything GitHub Actions needs to run `cdk deploy` with **no long-lived keys**.
 *
 *  1. An IAM OIDC identity provider for `token.actions.githubusercontent.com`.
 *     `OidcProviderNative` renders the native `AWS::IAM::OIDCProvider` resource;
 *     the older `OpenIdConnectProvider` L2 used a custom resource Lambda from
 *     before CloudFormation supported the type. No thumbprint is set: IAM now
 *     validates GitHub's certificate chain against its own trust store, and a
 *     pinned thumbprint would break on the next GitHub cert rotation.
 *  2. A role whose trust policy is the whole security model:
 *       aud == sts.amazonaws.com                       (the token was minted for AWS)
 *       sub ∈ { repo:o/r:ref:refs/heads/main, repo:o/r:environment:prod }
 *     Without the `sub` condition *any* GitHub repository could assume the role.
 *  3. A permission policy that only allows assuming the **CDK bootstrap roles**
 *     (`cdk-<qualifier>-{deploy,file-publishing,image-publishing,lookup}-role-*`).
 *     The CLI does all real work through those roles; the GitHub role itself
 *     needs nothing else. This keeps the blast radius of a leaked token to
 *     "can start a deployment", not "can do anything the deploy role can".
 */
export class GitHubOidcStack extends cdk.Stack {
  readonly provider: iam.IOidcProvider;
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: GitHubOidcStackProps) {
    super(scope, id, props);
    const qualifier = props.qualifier ?? cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER;

    this.provider = props.existingProviderArn
      ? iam.OidcProviderNative.fromOidcProviderArn(this, 'GitHubProvider', props.existingProviderArn)
      : new iam.OidcProviderNative(this, 'GitHubProvider', {
          url: `https://${GITHUB_OIDC_ISSUER}`,
          clientIds: [GITHUB_OIDC_AUDIENCE],
        });

    const subjects = [
      ...props.deployBranches.map((b) => `repo:${props.repo}:ref:refs/heads/${b}`),
      ...(props.deployEnvironments ?? []).map((e) => `repo:${props.repo}:environment:${e}`),
    ];

    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: `github-deploy-${props.repo.replace('/', '-')}`,
      description: `cdk deploy from GitHub Actions for ${props.repo}`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(this.provider.oidcProviderArn, {
        StringEquals: { [`${GITHUB_OIDC_ISSUER}:aud`]: GITHUB_OIDC_AUDIENCE },
        // StringLike so a branch pattern such as release/* can be expressed if needed.
        StringLike: { [`${GITHUB_OIDC_ISSUER}:sub`]: subjects },
      }),
    });

    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        // Any account this pipeline may deploy to must have bootstrapped with
        // `--trust <this account>`; the role name pattern is fixed by the bootstrap template.
        resources: [`arn:${cdk.Aws.PARTITION}:iam::*:role/cdk-${qualifier}-*-role-*`],
        conditions: { StringEquals: { 'iam:ResourceTag/aws-cdk:bootstrap-role': ['deploy', 'file-publishing', 'image-publishing', 'lookup'] } },
      }),
    );

    new cdk.CfnOutput(this, 'DeployRoleArn', { value: this.deployRole.roleArn, description: 'Set as role-to-assume in the workflow' });
  }
}
