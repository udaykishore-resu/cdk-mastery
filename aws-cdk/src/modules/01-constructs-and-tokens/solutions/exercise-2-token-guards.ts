import * as cdk from 'aws-cdk-lib';

/**
 * Exercise 2 — token-safe helpers.
 *
 * Every helper that takes a string from a construct must assume it may be a token.
 * Three strategies, from strict to permissive:
 *   1. refuse tokens with a clear message (`requireLiteral`),
 *   2. do the work at synth time when literal, defer to CloudFormation when not
 *      (`withSuffix`), or
 *   3. always defer to CloudFormation (`Fn.join`), accepting that the template gets an
 *      intrinsic even for literals (CDK collapses joins of pure literals, so this is free).
 */
export function requireLiteral(value: string, what: string): string {
  if (cdk.Token.isUnresolved(value)) {
    throw new Error(`${what} must be known at synth time; got a token. Pass a literal or restructure so the value is not deploy-time.`);
  }
  return value;
}

/** Appends a suffix to a bucket name; validates the S3 length limit when it can. */
export function withSuffix(bucketName: string, suffix: string): string {
  if (cdk.Token.isUnresolved(bucketName)) {
    return cdk.Fn.join('-', [bucketName, suffix]);
  }
  const candidate = `${bucketName}-${suffix}`;
  if (candidate.length > 63) throw new Error(`bucket name "${candidate}" exceeds 63 characters`);
  return candidate;
}

/** Number tokens cannot be compared; this returns undefined instead of a wrong answer. */
export function isWithin(value: number, min: number, max: number): boolean | undefined {
  if (cdk.Token.isUnresolved(value)) return undefined;
  return value >= min && value <= max;
}

/**
 * The third element of a list token: `list[2]` would be undefined at synth time (list tokens
 * are one-element arrays). `Fn.select` renders `{ "Fn::Select": [2, <list>] }`.
 */
export function third(list: string[]): string {
  return cdk.Token.isUnresolved(list) ? cdk.Fn.select(2, list) : list[2];
}
