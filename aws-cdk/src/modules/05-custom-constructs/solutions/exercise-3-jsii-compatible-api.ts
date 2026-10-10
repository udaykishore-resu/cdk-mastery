import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/**
 * Exercise 3 — make an API jsii-compatible.
 *
 * The "before" version (kept as a comment so the diff is visible) compiles fine in
 * TypeScript and fails `jsii` on four counts:
 *
 *   export interface NotifierProps<T extends sns.ITopic | sqs.IQueue> {   // (1) generics
 *     target: T;                                                          // (2) mutable prop
 *     encryption: kms.IKey | 'managed' | 'none';                          // (3) union of non-primitives
 *     onDelivered?: (id: string) => void;                                 // (4) function-typed prop
 *   }
 *
 * jsii rules that matter when you publish:
 *   - No generics anywhere in the public API (Java/C#/Python targets cannot map them).
 *   - Props interface members must be `readonly`; interfaces starting with `I` are
 *     *behavioural* (can be implemented by classes), others are *structs* (plain data).
 *   - Unions are only allowed between primitives; model choices as an enum, or a class
 *     with static factories (the `Encryption.kms(key)` idiom used by `BucketEncryption`,
 *     `ContainerImage.fromRegistry`, `Code.fromAsset`...).
 *   - No function-typed props or callbacks; use an interface with a method the caller
 *     implements (`INotificationHook`), which every language can implement.
 *   - Return types and props must be exported types (no anonymous object types), and
 *     `Record<string, string>` is the only map allowed (`{ [key: string]: string }`).
 *   - Public members cannot be overloaded; optional parameters go last.
 */

/** Choice-of-strategy as a class with static factories: extensible, self-documenting, jsii-safe. */
export class NotifierEncryption {
  static kms(key: kms.IKey): NotifierEncryption {
    return new NotifierEncryption('kms', key);
  }
  static managed(): NotifierEncryption {
    return new NotifierEncryption('managed');
  }
  static none(): NotifierEncryption {
    return new NotifierEncryption('none');
  }
  private constructor(
    readonly kind: 'kms' | 'managed' | 'none', // string-literal unions are primitives: allowed
    readonly key?: kms.IKey,
  ) {}
}

/** A behavioural interface replaces the callback prop. */
export interface INotificationHook {
  onDelivered(id: string): void;
}

/** Target as a behavioural interface both L2 kinds satisfy via small adapters — no generics. */
export interface INotifierTarget {
  readonly targetArn: string;
  bind(scope: Construct): void;
}

export class TopicTarget implements INotifierTarget {
  readonly targetArn: string;
  constructor(readonly topic: sns.ITopic) {
    this.targetArn = topic.topicArn;
  }
  bind(scope: Construct): void {
    new cdk.CfnOutput(scope, 'TopicTargetArn', { value: this.targetArn });
  }
}

export class QueueTarget implements INotifierTarget {
  readonly targetArn: string;
  constructor(readonly queue: sqs.IQueue) {
    this.targetArn = queue.queueArn;
  }
  bind(scope: Construct): void {
    new cdk.CfnOutput(scope, 'QueueTargetArn', { value: this.targetArn });
  }
}

export interface NotifierProps {
  readonly target: INotifierTarget;
  /** @default NotifierEncryption.managed() */
  readonly encryption?: NotifierEncryption;
  /** @default - no hook */
  readonly hook?: INotificationHook;
}

export class Notifier extends Construct {
  readonly encryption: NotifierEncryption;
  readonly target: INotifierTarget;

  constructor(scope: Construct, id: string, props: NotifierProps) {
    super(scope, id);
    this.encryption = props.encryption ?? NotifierEncryption.managed();
    this.target = props.target;
    props.target.bind(this);
    props.hook?.onDelivered(this.node.path);
  }
}
