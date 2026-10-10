import * as cdk from 'aws-cdk-lib';
import { EnvironmentTier, regionShortCode, resourceName } from '@cdk-mastery/shared';
import { Construct } from 'constructs';
import { ORG, SERVICE } from './config';
import { acknowledgeKnownFindings, applyPlatformGovernance } from './governance';
import { ApiStack } from './stacks/api-stack';
import { DataStack } from './stacks/data-stack';
import { NetworkStack } from './stacks/network-stack';
import { ObservabilityStack } from './stacks/observability-stack';
import { WorkerStack } from './stacks/worker-stack';

export interface OrdersPlatformStageProps extends cdk.StageProps {
  readonly tier: EnvironmentTier;
  readonly env: Required<cdk.Environment>;
  readonly alarmEmail?: string;
}

/**
 * The whole platform for one tier: five stacks, wired by references, governed
 * at the Stage. Deployment order falls out of the references:
 *
 *   Network ─┐
 *   Data ────┼─► Api ─► Worker ─► Observability
 *
 * Stack names carry org/service/tier/component/region so the CloudFormation
 * console reads like the architecture diagram.
 */
export class OrdersPlatformStage extends cdk.Stage {
  readonly tier: EnvironmentTier;
  readonly network: NetworkStack;
  readonly data: DataStack;
  readonly api: ApiStack;
  readonly worker: WorkerStack;
  readonly observability: ObservabilityStack;

  constructor(scope: Construct, id: string, props: OrdersPlatformStageProps) {
    super(scope, id, props);
    this.tier = props.tier;
    const { tier, env } = props;
    const name = (component: string) => resourceName({ org: ORG, service: SERVICE, env: tier.name, component, region: regionShortCode(env.region) });

    this.network = new NetworkStack(this, 'Network', { tier, env, stackName: name('network') });
    this.data = new DataStack(this, 'Data', { tier, env, stackName: name('data') });
    this.api = new ApiStack(this, 'Api', { tier, env, stackName: name('api'), tableName: this.data.tableName, tableKey: this.data.key });
    this.worker = new WorkerStack(this, 'Worker', {
      tier,
      env,
      stackName: name('worker'),
      tableName: this.data.tableName,
      bus: this.api.bus,
      key: this.data.key,
      vpc: this.network.vpc,
      securityGroup: this.network.workerSecurityGroup,
    });
    this.observability = new ObservabilityStack(this, 'Observability', {
      tier,
      env,
      stackName: name('observability'),
      api: this.api.api,
      apiHandler: this.api.handler,
      worker: this.worker.worker,
      queue: this.worker.queue,
      deadLetterQueue: this.worker.deadLetterQueue,
      key: this.data.key,
      alarmEmail: props.alarmEmail,
    });

    // Prod must never be torn down by a careless `cdk destroy`; dev must be cheap to recreate.
    if (tier.retainStatefulResources) {
      for (const stack of [this.network, this.data, this.api, this.worker, this.observability]) stack.terminationProtection = true;
    }

    applyPlatformGovernance(this, tier);
    acknowledgeKnownFindings({
      tier,
      tableName: this.data.tableName,
      lambdaFunctions: [this.api.handler, this.worker.worker],
      openRoutes: [this.api.healthRoute],
    });
  }
}
