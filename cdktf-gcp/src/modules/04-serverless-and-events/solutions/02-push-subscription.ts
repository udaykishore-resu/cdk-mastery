/**
 * Exercise 2 — push delivery to a private Cloud Run service with OIDC.
 *
 * A push subscription POSTs each message to an HTTPS endpoint. For a private
 * Cloud Run service the request needs an identity token, which Pub/Sub mints
 * *as a service account you name* (`oidcToken.serviceAccountEmail`). Two grants
 * make that work, and people forget the second one:
 *   1. the push SA needs `roles/run.invoker` on the service (the obvious one);
 *   2. the Pub/Sub service agent needs `roles/iam.serviceAccountTokenCreator`
 *      on the push SA — otherwise Pub/Sub cannot mint the token and every
 *      delivery fails with a 401/403 that appears in the *subscription*
 *      metrics, not in Cloud Run logs.
 *
 * Push vs pull: push scales the consumer for you and needs no client library;
 * pull gives flow control, batching, and works from anywhere (including
 * on-prem). Cloud Run + push is the common serverless shape.
 */
import { Construct } from 'constructs';
import { CloudRunV2Service } from '@cdktf/provider-google/lib/cloud-run-v2-service';
import { CloudRunV2ServiceIamMember } from '@cdktf/provider-google/lib/cloud-run-v2-service-iam-member';
import { PubsubSubscription } from '@cdktf/provider-google/lib/pubsub-subscription';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { ServiceAccountIamMember } from '@cdktf/provider-google/lib/service-account-iam-member';
import { EnvironmentTier, mandatoryTags, resourceName } from '@cdk-mastery/shared';
import { OrderTopics } from '../pubsub';

export interface PushSubscriptionProps {
  readonly tier: EnvironmentTier;
  readonly region: string;
  readonly projectNumber: string;
  readonly topics: OrderTopics;
  /** The private Cloud Run service that receives the POSTs. */
  readonly target: CloudRunV2Service;
  /** Path on the service, e.g. `/pubsub/orders`. */
  readonly path: string;
}

export class PushSubscription extends Construct {
  readonly pushAccount: ServiceAccount;
  readonly subscription: PubsubSubscription;

  constructor(scope: Construct, id: string, props: PushSubscriptionProps) {
    super(scope, id);
    const pubsubAgent = `serviceAccount:service-${props.projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com`;

    this.pushAccount = new ServiceAccount(this, 'PushAccount', {
      accountId: resourceName({ org: 'cdkm', service: 'events', env: props.tier.name, component: 'push' }),
      displayName: 'Pub/Sub push identity',
    });

    const invoker = new CloudRunV2ServiceIamMember(this, 'PushInvokesTarget', {
      name: props.target.name,
      location: props.region,
      role: 'roles/run.invoker',
      member: this.pushAccount.member,
    });
    const tokenCreator = new ServiceAccountIamMember(this, 'AgentMintsTokens', {
      serviceAccountId: this.pushAccount.name,
      role: 'roles/iam.serviceAccountTokenCreator',
      member: pubsubAgent,
    });

    this.subscription = new PubsubSubscription(this, 'Subscription', {
      name: `${props.topics.topic.name}-push`,
      topic: props.topics.topic.id,
      // Push acks on 2xx within this deadline; anything else is a nack + backoff.
      ackDeadlineSeconds: 30,
      retryPolicy: { minimumBackoff: '10s', maximumBackoff: '600s' },
      deadLetterPolicy: { deadLetterTopic: props.topics.deadLetterTopic.id, maxDeliveryAttempts: 5 },
      filter: 'attributes.type = "order.created"',
      expirationPolicy: { ttl: '' },
      pushConfig: {
        pushEndpoint: `${props.target.uri}${props.path}`,
        oidcToken: {
          serviceAccountEmail: this.pushAccount.email,
          // Audience defaults to the endpoint; pin it so a path change does not
          // silently change the token audience the service validates.
          audience: props.target.uri,
        },
        // Unwrapped payload: the raw message body as the POST body, attributes
        // as headers. Leave unset for the standard envelope ({"message": {...}}).
        attributes: { 'x-goog-version': 'v1' },
      },
      labels: mandatoryTags(props.tier, 'events'),
      dependsOn: [invoker, tokenCreator],
    });
  }
}
