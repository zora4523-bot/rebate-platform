// B1-04zm: 'rescan-window' job on the order-sync queue (规划/02 §7.1; D10-524). Payload rules follow
// jobs/order-sync.ts with query_kind 'rescan' only and `platforms` in place of scheduledPlatforms().
// A window fetches every page and sends each order through the existing pipeline, then advances the
// rescan cursor once. An order the pipeline first inserts here is one the increment missed, so the
// window also logs order_sync_rescan_found_missing; logs carry the counters, never order data.
// D10-545: a retry finds those rows unchanged, so a window that fails after a first insert still
// logs found_missing with the counts so far (finished pages and rows), then rethrows.
import type { ReceivedJob } from '../../platform/index.ts';
import type { RegisteredPlatform } from '../../union/index.ts';
import type { OrderPipelinePort } from '../application/pipeline-port.ts';
import type {
  SyncAccessPort,
  SyncCursorStore,
  SyncLogger,
  SyncRegistry,
} from '../application/sync-ports.ts';

export interface OrderRescanHandlerDeps {
  readonly access: SyncAccessPort;
  readonly cursors: Pick<SyncCursorStore, 'advance'>;
  readonly registry: SyncRegistry;
  readonly pipeline: OrderPipelinePort;
  /** Platforms a window may name; production passes scheduledPlatforms(). */
  readonly platforms: readonly RegisteredPlatform[];
  readonly logger?: SyncLogger;
}

export async function handleOrderRescanWindow(
  job: ReceivedJob,
  deps: OrderRescanHandlerDeps,
): Promise<void> {
  void job;
  void deps;
  throw new Error('NotImplemented: handleOrderRescanWindow');
}
