import { vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { JobQueue, ReceivedJob } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionAdapter, UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import type {
  OrderSyncWindow,
  SyncAccount,
  SyncAccessPort,
  SyncCursorStore,
  SyncSchedulerDeps,
} from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import type { OrderPipelinePort } from '../../../../apps/api/src/modules/orders/application/pipeline-port.ts';
import type { OrderSyncHandlerDeps } from '../../../../apps/api/src/modules/orders/jobs/order-sync.ts';

export const START = '2026-10-17T00:00:00.000Z';
export const END = '2026-10-17T00:30:00.000Z';
export const NOW = '2026-10-17T02:00:00.000Z';
export const ACCOUNT = '10000000-0000-4000-8000-000000000001';
export const account: SyncAccount = {
  app_id: 'sync-spec',
  platform: 'pdd',
  union_account_id: ACCOUNT,
  sync_start_at: START,
};
export const window: OrderSyncWindow = {
  app_id: account.app_id,
  platform: account.platform,
  union_account_id: ACCOUNT,
  query_kind: 'increment',
  scene: '-',
  window_start: START,
  window_end: END,
};
export const stream = {
  app_id: window.app_id,
  platform: window.platform,
  union_account_id: window.union_account_id,
  query_kind: window.query_kind,
  scene: window.scene,
};

export function job(payload: OrderSyncWindow = window, attempt = 1): ReceivedJob {
  return { id: 'synthetic-window-job', queue: 'order-sync', name: 'window', payload, attempt };
}

export function order(id: string, raw = '101'): UnionOrder {
  // Synthetic normalized DTO, not a fabricated platform response.
  return {
    platform: 'pdd',
    order_id: id,
    sub_order_id: id,
    paid_fen: 1000n,
    commission_fen: 100n,
    raw_payload_id: raw,
  };
}

export function fixture() {
  const clock = new FixedClock(NOW);
  const send = vi.fn<JobQueue['send']>().mockResolvedValue('queued-window');
  const read = vi.fn<SyncCursorStore['read']>().mockResolvedValue(null);
  const advance = vi.fn<SyncCursorStore['advance']>().mockResolvedValue(true);
  const listEnabledAccounts = vi
    .fn<SyncAccessPort['listEnabledAccounts']>()
    .mockResolvedValue([account]);
  const siteAuthAvailable = vi.fn<SyncAccessPort['siteAuthAvailable']>().mockResolvedValue(true);
  const offlineCircuitOpen = vi.fn<SyncAccessPort['offlineCircuitOpen']>().mockResolvedValue(false);
  const access = { listEnabledAccounts, siteAuthAvailable, offlineCircuitOpen };
  const cursors = { read, advance };
  const listOrders = vi
    .fn<UnionAdapter['listOrders']>()
    .mockResolvedValue({ items: [], nextCursor: null });
  const get = vi.fn(() => ({ listOrders }));
  const process = vi.fn<OrderPipelinePort['process']>().mockResolvedValue(undefined);
  const scheduler: SyncSchedulerDeps = { clock, queue: { send }, access, cursors };
  const handler: OrderSyncHandlerDeps = {
    access,
    cursors,
    registry: { get },
    pipeline: { process },
  };
  return {
    clock,
    send,
    read,
    advance,
    listEnabledAccounts,
    siteAuthAvailable,
    offlineCircuitOpen,
    listOrders,
    get,
    process,
    scheduler,
    handler,
  };
}
