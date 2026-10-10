import * as cdk from 'aws-cdk-lib';
import { ENVIRONMENTS } from '@cdk-mastery/shared';
import { EnvAgnosticStack, EnvSpecificStack, envFromContext } from './environments';
import { DUMMY_VPC_ID, LookupStack } from './lookups';
import { NestedDemoStack } from './nested';
import { AppStack, PlatformStack } from './ssm-sharing';
import { ResourceBudget } from './stack-budget';
import { StatefulStack, StatelessStack } from './stateful-stateless';

export * from './environments';
export * from './lookups';
export * from './nested';
export * from './ssm-sharing';
export * from './stack-budget';
export * from './stateful-stateless';

/**
 * Stack inventory (all `M02-*`):
 *   M02-Agnostic   env-agnostic (no env)
 *   M02-Specific   env-specific (env from cdk.json context `cdk-mastery:account/region`)
 *   M02-Stateful   env-agnostic; data; termination protection follows the tier
 *   M02-Stateless  env-agnostic; references M02-Stateful (strength per cdk.json: weak)
 *   M02-Platform   env-agnostic; publishes SSM parameters
 *   M02-App        env-agnostic; reads them with valueForStringParameter; depends on M02-Platform explicitly
 *   M02-Nested     env-agnostic; parent + one NestedStack
 *   M02-Lookup     env-specific; Vpc.fromLookup + valueFromLookup with seeded context (offline-safe)
 */
export function addToApp(app: cdk.App): void {
  const tier = ENVIRONMENTS.dev;
  const env = envFromContext(app);

  new EnvAgnosticStack(app, 'M02-Agnostic', { tier, description: 'cdk-mastery module 02: environment-agnostic stack' });
  new EnvSpecificStack(app, 'M02-Specific', { tier, env, description: 'cdk-mastery module 02: environment-specific stack' });

  const stateful = new StatefulStack(app, 'M02-Stateful', { tier, description: 'cdk-mastery module 02: stateful resources' });
  new StatelessStack(app, 'M02-Stateless', { tier, stateful, useBucket: true, description: 'cdk-mastery module 02: stateless consumer of M02-Stateful' });

  const platform = new PlatformStack(app, 'M02-Platform', { tier, description: 'cdk-mastery module 02: SSM publisher' });
  const appStack = new AppStack(app, 'M02-App', { tier, description: 'cdk-mastery module 02: SSM consumer' });
  // SSM sharing carries no reference CDK can see, so the deploy order must be stated.
  appStack.addStackDependency(platform, 'reads platform SSM parameters by name');

  new NestedDemoStack(app, 'M02-Nested', { tier, description: 'cdk-mastery module 02: nested stack' });

  new LookupStack(app, 'M02-Lookup', { tier, env, vpcId: DUMMY_VPC_ID, description: 'cdk-mastery module 02: context lookups (seeded)' });

  // In production you would add this once at the App level; here it is scoped to this
  // module's stacks so it does not annotate other modules' stacks behind their backs.
  const budget = new ResourceBudget();
  for (const stack of app.node.children) {
    if (cdk.Stack.isStack(stack) && stack.stackName.startsWith('M02-')) cdk.Aspects.of(stack).add(budget);
  }
}
