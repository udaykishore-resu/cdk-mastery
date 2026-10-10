/**
 * Exercise 3 — create a cross-stack cycle, watch CDKTF refuse it, then break it.
 *
 * Service A needs Service B's topic id; Service B needs Service A's service
 * account email. Each reference alone is fine; together they make A depend on
 * B and B on A, and `prepareStack()` throws
 * "Cannot add dependency … because it would cause a circular dependency".
 *
 * The fix is never "deploy twice". It is to notice that the *identities*
 * (topic name, SA email) are decidable at synth time and do not have to be
 * read from the other stack's state at all — or to move the shared piece into
 * a third stack that both depend on.
 */
import { App, TerraformOutput, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { PubsubTopic } from '@cdktf/provider-google/lib/pubsub-topic';
import { PubsubTopicIamMember } from '@cdktf/provider-google/lib/pubsub-topic-iam-member';
import { ServiceAccount } from '@cdktf/provider-google/lib/service-account';
import { gcpProject, gcpRegion } from '../gcp-config';

function provider(stack: TerraformStack, project?: string): void {
  new GoogleProvider(stack, 'Google', { project: project ?? gcpProject(), region: gcpRegion() });
}

// ---------------------------------------------------------------------------
// The broken shape: two stacks, each reading the other's attributes.
// ---------------------------------------------------------------------------
export class CyclicServiceA extends TerraformStack {
  readonly account: ServiceAccount;
  constructor(scope: Construct, id: string, project?: string) {
    super(scope, id);
    provider(this, project);
    this.account = new ServiceAccount(this, 'Publisher', { accountId: 'svc-a-publisher' });
  }
  /** Called after B exists — creates the A → B edge. */
  useTopic(topicId: string): void {
    new TerraformOutput(this, 'topic_id', { value: topicId });
  }
}

export class CyclicServiceB extends TerraformStack {
  readonly topic: PubsubTopic;
  constructor(scope: Construct, id: string, project?: string) {
    super(scope, id);
    provider(this, project);
    this.topic = new PubsubTopic(this, 'Events', { name: 'svc-b-events' });
  }
  /** Creates the B → A edge. */
  allowPublisher(memberToken: string): void {
    new PubsubTopicIamMember(this, 'PublisherBinding', { topic: this.topic.name, role: 'roles/pubsub.publisher', member: memberToken });
  }
}

/** Build the cycle. `prepareStack()` on either stack throws. */
export function buildCycle(app: App, project?: string): { a: CyclicServiceA; b: CyclicServiceB } {
  const a = new CyclicServiceA(app, 'cycle-a', project);
  const b = new CyclicServiceB(app, 'cycle-b', project);
  a.useTopic(b.topic.id);
  b.allowPublisher(a.account.member);
  return { a, b };
}

// ---------------------------------------------------------------------------
// The fix: one direction only. A's service account email is deterministic
// (`<accountId>@<project>.iam.gserviceaccount.com`), so B can grant it
// without reading A's state. A still reads B's topic id — that edge is fine.
// ---------------------------------------------------------------------------
export interface FixedServiceBProps {
  readonly project: string;
  /** The publisher's account id — a synth-time string, not a token from another stack. */
  readonly publisherAccountId: string;
}

export class FixedServiceB extends TerraformStack {
  readonly topic: PubsubTopic;
  constructor(scope: Construct, id: string, props: FixedServiceBProps) {
    super(scope, id);
    provider(this, props.project);
    this.topic = new PubsubTopic(this, 'Events', { name: 'svc-b-events' });
    new PubsubTopicIamMember(this, 'PublisherBinding', {
      topic: this.topic.name,
      role: 'roles/pubsub.publisher',
      member: `serviceAccount:${props.publisherAccountId}@${props.project}.iam.gserviceaccount.com`,
    });
  }
}

export class FixedServiceA extends TerraformStack {
  readonly account: ServiceAccount;
  constructor(scope: Construct, id: string, props: { project: string; accountId: string; topic: FixedServiceB }) {
    super(scope, id);
    provider(this, props.project);
    this.account = new ServiceAccount(this, 'Publisher', { accountId: props.accountId });
    new TerraformOutput(this, 'topic_id', { value: props.topic.topic.id });
  }
}

export function buildFixed(app: App, project = 'proj'): { a: FixedServiceA; b: FixedServiceB } {
  const accountId = 'svc-a-publisher';
  const b = new FixedServiceB(app, 'fixed-b', { project, publisherAccountId: accountId });
  const a = new FixedServiceA(app, 'fixed-a', { project, accountId, topic: b });
  return { a, b };
}
