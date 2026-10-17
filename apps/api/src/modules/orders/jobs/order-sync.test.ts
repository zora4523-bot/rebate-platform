// D10-36: the handler refuses a window whose account is not the one the credentials query.
import { expect, it, vi } from 'vitest';
import type { ReceivedJob } from '../../platform/index.ts';
import type { UnionAdapter } from '../../union/index.ts';
import type { OrderSyncWindow, SyncAccessPort, SyncLogger } from '../application/sync-ports.ts';
import { handleOrderSyncWindow, type OrderSyncHandlerDeps } from './order-sync.ts';

const A = '10000000-0000-4000-8000-00000000000a';
const B = '10000000-0000-4000-8000-00000000000b';
const win: OrderSyncWindow = {
  app_id: 'unit',
  platform: 'pdd',
  union_account_id: B,
  query_kind: 'increment',
  scene: '-',
  window_start: '2026-10-17T00:00:00.000Z',
  window_end: '2026-10-17T00:30:00.000Z',
};
const job: ReceivedJob = {
  id: 'j1',
  queue: 'order-sync',
  name: 'window',
  payload: win,
  attempt: 1,
};

function setup(queryable?: SyncAccessPort['queryableAccount']) {
  const listOrders = vi
    .fn<UnionAdapter['listOrders']>()
    .mockResolvedValue({ items: [], nextCursor: null });
  const advance = vi.fn().mockResolvedValue(true);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: OrderSyncHandlerDeps = {
    access: {
      listEnabledAccounts: vi.fn(),
      siteAuthAvailable: vi.fn().mockResolvedValue(true),
      offlineCircuitOpen: vi.fn().mockResolvedValue(false),
      ...(queryable === undefined ? {} : { queryableAccount: queryable }),
    },
    cursors: { read: vi.fn(), advance },
    registry: { get: () => ({ listOrders }) },
    pipeline: { process: vi.fn().mockResolvedValue(undefined) },
    logger: logger as unknown as SyncLogger,
  };
  return { deps, listOrders, advance, logger };
}

it('[AC-B1-08g#u9] 任务账号与可查询账号一致时照常拉取并推进水位', async () => {
  const s = setup(vi.fn().mockResolvedValue(B));
  await handleOrderSyncWindow(job, s.deps);
  expect(s.listOrders).toHaveBeenCalledTimes(1);
  expect(s.advance).toHaveBeenCalledExactlyOnceWith(win);
  expect(s.logger.error).not.toHaveBeenCalled();
});

it.each([
  [A, 'not_queryable_account'],
  [null, 'no_queryable_account'],
])(
  '[AC-B1-08g#u10] 可查询账号为 %s 时：error 日志、不拉取、不推进、正常结束',
  async (queryable, reason) => {
    const s = setup(vi.fn().mockResolvedValue(queryable));
    await expect(handleOrderSyncWindow(job, s.deps)).resolves.toBeUndefined();
    expect(s.listOrders).not.toHaveBeenCalled();
    expect(s.advance).not.toHaveBeenCalled();
    expect(s.logger.error).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ platform: 'pdd', union_account_id: B, reason }),
      'order_sync_window_account_mismatch',
    );
  },
);

it('[AC-B1-08g#u11] 端口未提供 queryableAccount 时行为不变', async () => {
  const s = setup();
  await handleOrderSyncWindow(job, s.deps);
  expect(s.listOrders).toHaveBeenCalledTimes(1);
  expect(s.advance).toHaveBeenCalledExactlyOnceWith(win);
});
