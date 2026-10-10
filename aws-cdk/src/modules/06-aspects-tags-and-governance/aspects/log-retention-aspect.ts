import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { IConstruct } from 'constructs';

export interface LogRetentionAspectProps {
  /** Retention applied to every log group that has none. */
  readonly defaultRetention: logs.RetentionDays;
  /**
   * Hard ceiling. Log groups that ask for *more* than this are clamped down and
   * an info annotation is emitted — useful when a tier (dev) must never keep logs
   * for a year just because someone copy-pasted a prod construct.
   * @default - no ceiling
   */
  readonly maxRetention?: logs.RetentionDays;
}

/**
 * MUTATING aspect over `AWS::Logs::LogGroup`.
 *
 * Log groups are the classic "forgotten cost": every Lambda, every ECS task and
 * every Step Functions state machine creates one, and with the
 * `@aws-cdk/aws-lambda:useCdkManagedLogGroup` flag they are explicit CFN resources.
 * The default is *never expire*. One aspect at the App level fixes the whole fleet.
 *
 * Note on tokens: `retentionInDays` may be an unresolved token (a CfnParameter,
 * a Lazy). We only clamp when the value is a concrete number; a token is treated
 * as "explicitly configured, leave it alone".
 */
export class LogRetentionAspect implements cdk.IAspect {
  constructor(private readonly props: LogRetentionAspectProps) {}

  visit(node: IConstruct): void {
    if (!(node instanceof logs.CfnLogGroup)) return;

    const current = node.retentionInDays;
    if (current === undefined) {
      node.retentionInDays = this.props.defaultRetention;
      return;
    }
    if (this.props.maxRetention === undefined) return;
    if (typeof current !== 'number' || cdk.Token.isUnresolved(current)) return;
    if (current > this.props.maxRetention) {
      cdk.Annotations.of(node).addInfo(
        `LogRetentionAspect: clamped retention from ${current} to ${this.props.maxRetention} days`,
      );
      node.retentionInDays = this.props.maxRetention;
    }
  }
}
