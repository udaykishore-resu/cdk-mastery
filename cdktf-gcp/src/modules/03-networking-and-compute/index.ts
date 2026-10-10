import { App } from 'cdktf';
import { CloudRunStack } from './cloud-run-stack';
import { CloudSqlStack } from './cloud-sql-stack';
import { NetworkStack } from './network-stack';

export * from './gcp-config';
export * from './services';
export * from './network-stack';
export * from './cloud-sql-stack';
export * from './cloud-run-stack';

/**
 * Deploy order (from the cross-stack references): m03-network → m03-cloud-sql → m03-cloud-run.
 * `cdktf deploy m03-network m03-cloud-sql m03-cloud-run` or `cdktf deploy 'm03-*'`.
 */
export function addToApp(app: App): void {
  const tier = 'dev';
  const network = new NetworkStack(app, 'm03-network', { tier });
  const database = new CloudSqlStack(app, 'm03-cloud-sql', { tier, network });
  new CloudRunStack(app, 'm03-cloud-run', { tier, network, database });
}
