'use strict';
/**
 * Provider-framework `onEvent` handler for Custom::SlowResource.
 *
 * Contract (framework, not raw CloudFormation):
 *   input : { RequestType: 'Create'|'Update'|'Delete', ResourceProperties, OldResourceProperties?, PhysicalResourceId? }
 *   output: { PhysicalResourceId?, Data?, ... } — or nothing. NEVER the raw CFN
 *           response shape; the framework talks to CloudFormation for you.
 *
 * Idempotency rules that matter in production:
 *   - Create must return a PhysicalResourceId the framework can hand to isComplete.
 *   - Update that returns a *different* PhysicalResourceId makes CloudFormation
 *     send a Delete for the old one afterwards (that is how replacement works).
 *   - Delete must succeed for a resource that no longer exists (rollbacks retry).
 *   - Throwing here fails the resource; the framework reports the error message.
 */
exports.handler = async (event) => {
  console.log(JSON.stringify({ msg: 'onEvent', type: event.RequestType, props: event.ResourceProperties }));
  const name = event.ResourceProperties.Name;
  if (!name) throw new Error('Name is required');

  switch (event.RequestType) {
    case 'Create':
      // Kick off the long-running operation here (an API call that returns a job id).
      // We simulate it: the "job" is identified by the name plus a start timestamp.
      return { PhysicalResourceId: `slow-${name}`, Data: { StartedAt: new Date().toISOString() } };
    case 'Update':
      if (event.OldResourceProperties && event.OldResourceProperties.Name !== name) {
        // Name is immutable → replacement: new physical id, CFN will Delete the old one.
        return { PhysicalResourceId: `slow-${name}` };
      }
      return { PhysicalResourceId: event.PhysicalResourceId };
    case 'Delete':
      // Tear down the external thing; swallow "not found".
      return { PhysicalResourceId: event.PhysicalResourceId };
    default:
      throw new Error(`Unknown RequestType ${event.RequestType}`);
  }
};
