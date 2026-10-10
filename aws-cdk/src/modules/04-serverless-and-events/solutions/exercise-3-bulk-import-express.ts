import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

/**
 * Exercise 3 — an Express workflow that fans out a bulk import to the event bus.
 *
 * Input: `{ "orders": [ { orderId, customerId, total }, ... ] }`
 * A `Map` state iterates `$.orders` with bounded concurrency; each item is normalised by a
 * `Pass` state and published as `OrderPlaced` with `EventBridgePutEvents` — closing the
 * loop with EventsStack, whose rule → queue → worker picks them up.
 *
 * Express vs Standard: Express runs up to 5 minutes, at-least-once, billed per duration —
 * right for high-volume, short, idempotent work. Standard is exactly-once per state,
 * up to a year, billed per transition — right for the saga. Express workflows must log to
 * CloudWatch to have any execution history at all.
 */
export interface BulkImportProps {
  readonly bus: events.IEventBus;
  readonly maxConcurrency?: number;
  readonly logGroup: logs.ILogGroup;
}

export class BulkImport extends Construct {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: BulkImportProps) {
    super(scope, id);

    const normalise = new sfn.Pass(this, 'Normalise', {
      parameters: {
        orderId: sfn.JsonPath.stringAt('$.orderId'),
        customerId: sfn.JsonPath.stringAt('$.customerId'),
        total: sfn.JsonPath.numberAt('$.total'),
        placedAt: sfn.JsonPath.stringAt('$$.State.EnteredTime'),
      },
    });

    const publish = new tasks.EventBridgePutEvents(this, 'PublishOrderPlaced', {
      entries: [
        {
          eventBus: props.bus,
          source: 'cdk-mastery.orders',
          detailType: 'OrderPlaced',
          detail: sfn.TaskInput.fromJsonPathAt('$'),
        },
      ],
      resultPath: sfn.JsonPath.DISCARD,
    });

    const perOrder = new sfn.Map(this, 'ForEachOrder', {
      itemsPath: sfn.JsonPath.stringAt('$.orders'),
      maxConcurrency: props.maxConcurrency ?? 5,
      resultPath: sfn.JsonPath.DISCARD,
    }).itemProcessor(normalise.next(publish));

    this.stateMachine = new sfn.StateMachine(this, 'BulkImport', {
      stateMachineType: sfn.StateMachineType.EXPRESS,
      definitionBody: sfn.DefinitionBody.fromChainable(perOrder.next(new sfn.Succeed(this, 'Imported'))),
      timeout: cdk.Duration.minutes(5),
      logs: { destination: props.logGroup, level: sfn.LogLevel.ALL, includeExecutionData: false },
    });
  }
}
