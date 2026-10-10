import { TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { PubsubTopic } from '@cdktf/provider-google/lib/pubsub-topic';
import { PubsubTopicIamMember } from '@cdktf/provider-google/lib/pubsub-topic-iam-member';
import { PubsubTopicIamBinding } from '@cdktf/provider-google/lib/pubsub-topic-iam-binding';
import { PubsubTopicIamPolicy } from '@cdktf/provider-google/lib/pubsub-topic-iam-policy';
import { DataGoogleIamPolicy } from '@cdktf/provider-google/lib/data-google-iam-policy';
import { gcpProject, gcpRegion } from './gcp-config';

export type IamStyle = 'member' | 'binding' | 'policy';

export interface IamTrapStackProps {
  readonly style: IamStyle;
  readonly project?: string;
  /** Principals that should be able to publish. */
  readonly publishers: readonly string[];
}

/**
 * The same intent — "these principals may publish to this topic" — written
 * three ways. Every `google_*_iam_*` family (project, bucket, topic, secret,
 * service account, Cloud Run service, …) has exactly these three shapes.
 *
 *   _iam_member   additive     one (role, member) pair; never touches anything else
 *   _iam_binding  authoritative for ONE role: the members list *replaces* whoever
 *                              held that role, including members added by the
 *                              console, by another stack, or by Google itself
 *   _iam_policy   authoritative for EVERYTHING: the policy *replaces* the entire
 *                              IAM policy of the resource — every role, every member
 *
 * The lock-yourself-out story, seen in real life:
 *   1. Team A manages `roles/owner` on a project with `google_project_iam_binding`
 *      listing their group.
 *   2. Team B (or a break-glass runbook) adds an on-call engineer as owner in
 *      the console during an incident.
 *   3. Team A's next `terraform apply` shows "~ members: - user:oncall@…" and
 *      someone approves it because the diff "just restores the desired state".
 *      The on-call loses owner mid-incident.
 *   4. Worse variant: a `google_project_iam_policy` written for a *new* project
 *      is applied to an *existing* one. It contains no
 *      `roles/owner` for the deployer, no Google service agents, nothing. Apply
 *      succeeds — the API is happy — and the very next call from the deployer
 *      is a 403. Recovery needs an org admin (or a Google support case).
 *
 * Rules: `_iam_member` by default; `_iam_binding` only for roles you truly
 * own end-to-end (and never `roles/owner`); `_iam_policy` only on resources
 * your stack creates and that nothing else will ever touch (a Pub/Sub topic
 * you created a second ago is fine; a project is not).
 */
export class IamTrapStack extends TerraformStack {
  readonly topic: PubsubTopic;

  constructor(scope: Construct, id: string, props: IamTrapStackProps) {
    super(scope, id);
    new GoogleProvider(this, 'Google', { project: props.project ?? gcpProject(), region: gcpRegion() });
    this.topic = new PubsubTopic(this, 'Topic', { name: 'iam-trap-demo' });

    switch (props.style) {
      case 'member':
        // N resources, each independent. Removing one from the list removes
        // exactly that grant. Other publishers (added elsewhere) are untouched.
        props.publishers.forEach((member, i) => {
          new PubsubTopicIamMember(this, `Publisher${i}`, { topic: this.topic.name, role: 'roles/pubsub.publisher', member });
        });
        break;

      case 'binding':
        // One resource; the list is the truth for roles/pubsub.publisher on
        // this topic. A publisher added by hand is *removed* on next apply.
        new PubsubTopicIamBinding(this, 'Publishers', {
          topic: this.topic.name,
          role: 'roles/pubsub.publisher',
          members: [...props.publishers],
        });
        break;

      case 'policy': {
        // The whole policy. Anything not listed here — including bindings for
        // Google service agents that other features (dead-lettering!) rely on —
        // is removed on apply.
        const policy = new DataGoogleIamPolicy(this, 'Policy', {
          binding: [{ role: 'roles/pubsub.publisher', members: [...props.publishers] }],
        });
        new PubsubTopicIamPolicy(this, 'TopicPolicy', { topic: this.topic.name, policyData: policy.policyData });
        break;
      }
    }
  }
}
