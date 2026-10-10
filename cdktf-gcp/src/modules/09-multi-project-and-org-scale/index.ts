import { App } from 'cdktf';
import { FoldersStack, HostStack, ServiceProjectStack } from './stacks';

export * from './org-config';
export * from './project-factory';
export * from './folders';
export * from './regional-providers';
export * from './shared-vpc';
export * from './beta';
export * from './stacks';

/**
 * Stack per project, driven by ENVIRONMENTS. Deploy order (data dependencies
 * make `cdktf deploy` enforce it; listing it keeps humans honest):
 *   m09-folders -> m09-<env>-host -> m09-<env>-orders
 */
export function addToApp(app: App): void {
  const folders = new FoldersStack(app, 'm09-folders');
  for (const env of ['dev', 'prod'] as const) {
    const host = new HostStack(app, `m09-${env}-host`, { tier: env, folderId: folders.folders.byEnvironment[env].folderId });
    new ServiceProjectStack(app, `m09-${env}-orders`, { tier: env, service: 'orders', folderId: folders.folders.byEnvironment[env].folderId, host });
  }
}
