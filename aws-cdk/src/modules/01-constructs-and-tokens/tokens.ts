import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Tokens are the price of building templates in a program: any value CloudFormation only
 * knows at deploy time (a generated bucket name, an ARN, `AWS::Region`) has to be carried
 * through your TypeScript as a *placeholder*. In TS a string token looks like
 * `${Token[TOKEN.123]}`; a number token is a large negative number; a list token is a
 * one-element array `["#{Token[TOKEN.124]}"]`. At synthesis they are replaced by
 * `{ "Ref": ... }`, `{ "Fn::GetAtt": ... }`, `{ "Fn::Join": ... }` and friends.
 *
 * Rules that follow from that:
 *   - You may concatenate string tokens (`\`${a}-${b}\``); CDK turns that into Fn::Join.
 *   - You may NOT inspect them: `.length`, `.toUpperCase()`, `.split()`, `===`, regex —
 *     all operate on the placeholder text, silently producing garbage.
 *   - Number tokens cannot be used in arithmetic; list tokens cannot be indexed with `[i]`
 *     (use `Fn.select`).
 *   - Ask before you touch: `Token.isUnresolved(x)`; and resolve only where the framework
 *     does — `stack.resolve()` is for tests and debugging, not for construct code.
 */

export interface TokensStackProps extends cdk.StackProps {
  readonly tier: string;
}

export class TokensStack extends cdk.Stack {
  readonly bucket: s3.Bucket;
  readonly queue: sqs.Queue;
  /** The value CDK would render for `bucket.bucketName` — filled in for the test/README. */
  readonly rendered: Record<string, unknown>;

  constructor(scope: Construct, id: string, props: TokensStackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, 'Data', { removalPolicy: cdk.RemovalPolicy.DESTROY });
    this.queue = new sqs.Queue(this, 'Events', { enforceSSL: true });

    // 1. String interpolation of tokens is fine: this becomes Fn::Join.
    const objectUrl = `s3://${this.bucket.bucketName}/${props.tier}/manifest.json`;

    // 2. Fn.* are the CloudFormation intrinsics as typed helpers. They return tokens too.
    const queueAccount = cdk.Fn.select(4, cdk.Fn.split(':', this.queue.queueArn));
    const subbed = cdk.Fn.sub('arn:${AWS::Partition}:s3:::${BucketName}/*', { BucketName: this.bucket.bucketName });
    const joined = cdk.Fn.join('/', [this.bucket.bucketArn, 'prefix', '*']);

    // 3. Lazy: a token whose value is computed at synthesis, after the tree is complete.
    //    Classic use: "the list of all X added so far" where X is added by later code.
    const registeredHandlers: string[] = [];
    const handlerList = cdk.Lazy.list({ produce: () => registeredHandlers.slice().sort() });
    const handlerCount = cdk.Lazy.number({ produce: () => registeredHandlers.length });
    const summary = cdk.Lazy.string({ produce: () => `${registeredHandlers.length} handlers registered` });
    registeredHandlers.push('orders', 'billing'); // added AFTER the Lazy was created; still visible.

    new ssm.StringParameter(this, 'Manifest', {
      parameterName: `/cdk-mastery/${props.tier}/tokens/manifest-url`,
      stringValue: objectUrl,
    });
    new ssm.StringListParameter(this, 'Handlers', {
      parameterName: `/cdk-mastery/${props.tier}/tokens/handlers`,
      stringListValue: handlerList,
    });
    new ssm.StringParameter(this, 'Summary', {
      parameterName: `/cdk-mastery/${props.tier}/tokens/summary`,
      stringValue: summary,
    });

    // 4. Duration and Size are *not* tokens; they are typed units that render to numbers
    //    in the unit the L1 wants (seconds for SQS, MiB for Lambda memory, GiB for EBS).
    const retention = cdk.Duration.days(4);
    const bigBatch = cdk.Size.mebibytes(256);
    new cdk.CfnOutput(this, 'RetentionSeconds', { value: `${retention.toSeconds()}` }); // 345600
    new cdk.CfnOutput(this, 'BatchGiB', { value: `${bigBatch.toGibibytes({ rounding: cdk.SizeRoundingBehavior.NONE })}` }); // 0.25

    // 5. What the framework will render. `stack.resolve()` is how the tests below assert
    //    these claims; in construct code you almost never need it.
    this.rendered = {
      bucketName: this.resolve(this.bucket.bucketName),
      objectUrl: this.resolve(objectUrl),
      queueAccount: this.resolve(queueAccount),
      subbed: this.resolve(subbed),
      joined: this.resolve(joined),
      handlerCount: this.resolve(handlerCount),
      region: this.resolve(this.region), // { Ref: 'AWS::Region' } — no env was given
      awsRegion: this.resolve(cdk.Aws.REGION), // same thing, via the pseudo-parameter constant
    };
  }
}

/**
 * The bug this module exists to prevent, as a pair of functions.
 *
 * `namingBug` "works" in a unit test with a literal and produces `${TOKEN[TOKEN.5]}-…`
 * garbage — or throws a validation error about characters — with a real bucket.
 * `namingFix` checks first and pushes the string work into CloudFormation.
 */
export function namingBug(bucketName: string): string {
  return `${bucketName.toUpperCase().slice(0, 8)}-index`;
}

export function namingFix(bucketName: string): string {
  if (cdk.Token.isUnresolved(bucketName)) {
    // Cannot upper-case at synth time; there is no Fn::Upper, so keep the token intact and
    // let the caller decide whether case matters. Composition is always safe.
    return `${bucketName}-index`;
  }
  return `${bucketName.toUpperCase().slice(0, 8)}-index`;
}

/** `Tokenization.isResolvable` tells an IResolvable (Lazy, intrinsic) from a plain object. */
export function classify(value: unknown): 'resolvable' | 'string-token' | 'number-token' | 'list-token' | 'literal' {
  if (cdk.Tokenization.isResolvable(value)) return 'resolvable';
  if (typeof value === 'string' && cdk.Token.isUnresolved(value)) return 'string-token';
  if (typeof value === 'number' && cdk.Token.isUnresolved(value)) return 'number-token';
  if (Array.isArray(value) && cdk.Token.isUnresolved(value)) return 'list-token';
  return 'literal';
}
