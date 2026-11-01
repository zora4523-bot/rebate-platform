import { expect, it, vi } from 'vitest';
import type { ReceivedJob } from '../../platform/index.ts';
import type { UnionAdapter, UnionOrder } from '../../union/index.ts';
import type { OrderPipelinePort } from '../application/pipeline-types.ts';
import type { SyncCursorStore } from '../application/sync-ports.ts';
import { handleOrderRescanWindow } from './order-rescan.ts';

const payload = {
  app_id: 'rescan-unit',
  platform: 'jd',
  union_account_id: '20000000-0000-4000-8000-000000000001',
  query_kind: 'rescan',
  scene: '-',
  window_start: '2026-10-01T00:00:00.000Z',
  window_end: '2026-10-01T01:00:00.000Z',
};
const job: ReceivedJob = {
  id: 'synthetic-rescan-job',
  queue: 'order-sync',
  name: 'rescan.window',
  payload,
  attempt: 1,
};
const row: UnionOrder = {
  platform: 'jd',
  order_id: 'synthetic-order',
  sub_order_id: 'synthetic-order',
  paid_fen: 1000n,
  commission_fen: 100n,
  raw_payload_id: '101',
};

it('[AC-B1-04zm] 游标按 rescan 窗口推进；流水线上下文的 query_kind 只为满足类型', async () => {
  const advance = vi.fn<SyncCursorStore['advance']>(async () => true);
  const process = vi.fn<OrderPipelinePort['process']>(async () => ({ kind: 'unchanged' }));
  const listOrders = vi
    .fn<UnionAdapter['listOrders']>()
    .mockResolvedValue({ items: [row], nextCursor: null });
  await handleOrderRescanWindow(job, {
    access: {
      listEnabledAccounts: async () => [],
      siteAuthAvailable: async () => true,
      offlineCircuitOpen: async () => false,
    },
    cursors: { advance },
    registry: { get: () => ({ listOrders }) },
    pipeline: { process },
    platforms: ['jd'],
  });
  expect(advance).toHaveBeenCalledExactlyOnceWith(payload);
  expect(process.mock.calls[0]?.[1]).toMatchObject({ query_kind: 'increment' });
});
