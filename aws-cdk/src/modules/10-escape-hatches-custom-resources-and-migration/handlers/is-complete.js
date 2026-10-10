'use strict';
/**
 * Provider-framework `isComplete` handler.
 *
 * Called on a schedule (`queryInterval`) until it returns `{ IsComplete: true }`
 * or `totalTimeout` elapses (then the resource fails). It receives the onEvent
 * output merged into the event, so `event.PhysicalResourceId` and `event.Data`
 * are available. `Data` returned here becomes the custom resource's attributes
 * (`Fn::GetAtt` / `resource.getAttString('Result')`).
 *
 * The simulated job "completes" once a configurable number of seconds have
 * passed since Create — enough to see the waiter state machine do its job.
 */
exports.handler = async (event) => {
  console.log(JSON.stringify({ msg: 'isComplete', type: event.RequestType, id: event.PhysicalResourceId }));
  if (event.RequestType === 'Delete') return { IsComplete: true };

  const waitSeconds = Number(event.ResourceProperties.WaitSeconds || 0);
  const startedAt = event.Data && event.Data.StartedAt ? Date.parse(event.Data.StartedAt) : Date.now();
  const elapsed = (Date.now() - startedAt) / 1000;
  if (elapsed < waitSeconds) return { IsComplete: false };

  return { IsComplete: true, Data: { Result: `ready after ${Math.round(elapsed)}s`, Name: event.ResourceProperties.Name } };
};
