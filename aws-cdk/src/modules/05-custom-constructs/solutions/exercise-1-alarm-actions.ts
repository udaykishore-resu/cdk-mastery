import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { QueueWorker } from '../queue-worker';

/**
 * Exercise 1 — wire every alarm a construct owns to a notification topic.
 *
 * The construct exposes `alarms: Alarm[]` precisely so that callers do not need to know
 * the alarm names. A generic helper can therefore fan out actions to any construct that
 * follows the convention — the same reason L2s expose `connections`, `grant*`, `metric*`.
 */
export interface HasAlarms {
  readonly alarms: cloudwatch.Alarm[];
}

export function notifyOnAlarm(target: HasAlarms, topic: sns.ITopic, options: { readonly alsoOnOk?: boolean } = {}): void {
  const action = new actions.SnsAction(topic);
  for (const alarm of target.alarms) {
    alarm.addAlarmAction(action);
    if (options.alsoOnOk) alarm.addOkAction(action);
  }
}

/** Convenience: a worker with all alarms pointed at a topic, in one call. */
export function queueWorkerWithNotifications(worker: QueueWorker, topic: sns.ITopic): QueueWorker {
  notifyOnAlarm(worker, topic, { alsoOnOk: true });
  return worker;
}
