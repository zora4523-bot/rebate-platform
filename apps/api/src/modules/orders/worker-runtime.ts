import type { OrderPipelinePort } from './application/pipeline-types.ts';
import type { SyncAccessPort, SyncCursorStore, SyncRegistry } from './application/sync-ports.ts';
import type { StatusMap } from './domain/status-map.ts';
import type { RegisteredPlatform } from '../union/index.ts';

export interface OrderSyncRuntime {
  readonly access: SyncAccessPort;
  readonly cursors: SyncCursorStore;
  readonly registry: SyncRegistry;
  readonly pipeline: OrderPipelinePort;
  readonly statusMaps: (platform: RegisteredPlatform) => StatusMap;
  start(): { stop(): Promise<void> };
}

export function orderSyncToken(): symbol {
  throw new Error('NotImplemented: orderSyncToken');
}
