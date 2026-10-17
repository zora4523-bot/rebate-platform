import type { ReceivedJob } from '../../platform/index.ts';
import type { OrderPipelinePort } from '../application/pipeline-port.ts';
import type { SyncAccessPort, SyncCursorStore, SyncRegistry } from '../application/sync-ports.ts';

export interface OrderSyncHandlerDeps {
  readonly access: SyncAccessPort;
  readonly cursors: SyncCursorStore;
  readonly registry: SyncRegistry;
  readonly pipeline: OrderPipelinePort;
}

export async function handleOrderSyncWindow(
  job: ReceivedJob,
  deps: OrderSyncHandlerDeps,
): Promise<void> {
  void job;
  void deps;
  throw new Error('NotImplemented: handleOrderSyncWindow');
}
