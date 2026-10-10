/**
 * @cdk-mastery/shared
 *
 * The one thing AWS CDK and CDK for Terraform have in common is the `constructs`
 * package: both build a tree of `Construct` nodes and both "synthesize" that tree
 * into a declarative artifact (a CloudFormation template, or a Terraform JSON
 * configuration). Anything written purely against `constructs` — naming rules,
 * environment definitions, a tagging policy walker — therefore works in BOTH
 * frameworks unchanged. This package is that proof, and it is imported by both
 * tracks.
 *
 * Nothing in here imports `aws-cdk-lib` or `cdktf`.
 */
export * from './environment';
export * from './naming';
export * from './policy';
