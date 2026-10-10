import { TerraformOutput, TerraformStack } from 'cdktf';
import { Construct } from 'constructs';
import { GoogleProvider } from '@cdktf/provider-google/lib/provider';
import { PubsubTopic } from '@cdktf/provider-google/lib/pubsub-topic';
import { environmentFor, mandatoryTags, resourceName } from '@cdk-mastery/shared';
import { BackendConfig, backendFromEnv, configureBackend } from './backend';
import { gcpProject, gcpRegion } from './gcp-config';

export interface BackendDemoStackProps {
  readonly tier: string;
  /** Explicit backend; defaults to `backendFromEnv(id)`. */
  readonly backend?: BackendConfig;
  readonly project?: string;
  readonly region?: string;
}

/**
 * The smallest deployable stack, used to show the three backends side by side
 * and to be the target of the example workflow's drift-detection job.
 */
export class BackendDemoStack extends TerraformStack {
  readonly topic: PubsubTopic;

  constructor(scope: Construct, id: string, props: BackendDemoStackProps) {
    super(scope, id);
    const tier = environmentFor(props.tier);
    new GoogleProvider(this, 'Google', { project: props.project ?? gcpProject(), region: props.region ?? gcpRegion() });
    configureBackend(this, props.backend ?? backendFromEnv(id));

    this.topic = new PubsubTopic(this, 'Heartbeat', {
      name: resourceName({ org: 'cdkm', service: 'cicd', env: tier.name, component: 'heartbeat' }),
      labels: mandatoryTags(tier, 'cicd'),
    });
    new TerraformOutput(this, 'TopicId', { value: this.topic.id });
  }
}
