// B1-09i: the manual sync handler's breaker check and its write-back on the last failed attempt.
import { expect, it, vi } from 'vitest';
import type { ReceivedJob } from '../../platform/index.ts';
import type { UnionAdapter } from '../../union/index.ts';
import type { SyncLogger } from '../application/sync-ports.ts';
import type { OrderSyncRequestProgress } from '../infra/order-sync-requests.ts';
import {
  handleManualSyncJob,
  MANUAL_SYNC_RETRY_LIMIT,
  type ManualSyncHandlerDeps,
} from './manual-sync.ts';

const ACC = '10000000-0000-4000-8000-00000000000a';
const SYNC = '10000000-0000-4000-8000-000000000001';

function job(attempt: number, final = false): ReceivedJob {
  return {
    id: 'j1',
    queue: 'order-sync',
    name: 'manual-window',
    payload: {
      app_id: 'unit',
      platform: 'pdd',
      union_account_id: ACC,
      scene: '-',
      query_kind: 'increment',
      window_start: '2026-10-17T00:00:00.000Z',
      window_end: '2026-10-17T00:30:00.000Z',
      sync_id: SYNC,
      sync_final: final,
    },
    attempt,
  };
}

function setup(open = false) {
  const listOrders = vi
    .fn<UnionAdapter['listOrders']>()
    .mockResolvedValue({ items: [], nextCursor: null });
  const requests = {
    status: vi.fn<OrderSyncRequestProgress['status']>().mockResolvedValue('running'),
    start: vi.fn<OrderSyncRequestProgress['start']>().mockResolvedValue(undefined),
    record: vi.fn<OrderSyncRequestProgress['record']>().mockResolvedValue(undefined),
    fail: vi.fn<OrderSyncRequestProgress['fail']>().mockResolvedValue(undefined),
  };
  const offlineCircuitOpen = vi.fn().mockResolvedValue(open);
  const deps: ManualSyncHandlerDeps = {
    access: {
      listEnabledAccounts: vi.fn(),
      siteAuthAvailable: vi.fn().mockResolvedValue(true),
      offlineCircuitOpen,
      queryableAccount: vi.fn().mockResolvedValue(ACC),
    },
    registry: { get: () => ({ listOrders }) },
    pipeline: { process: vi.fn().mockResolvedValue(undefined) },
    requests,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as SyncLogger,
  };
  return { deps, listOrders, requests, offlineCircuitOpen };
}

it('[AC-B1-09i#u1] worker 的离线熔断打开时取到任务不拉取，请求记 failed（offline_circuit_open）', async () => {
  const s = setup(true);
  await handleManualSyncJob(job(1), s.deps);
  expect(s.offlineCircuitOpen).toHaveBeenCalledWith('pdd');
  expect(s.listOrders).not.toHaveBeenCalled();
  expect(s.requests.start).not.toHaveBeenCalled();
  expect(s.requests.fail).toHaveBeenCalledWith('unit', SYNC, 'offline_circuit_open');
});

it('[AC-B1-09i#u2] 未到最后一次的拉取失败只抛出交队列重试，不动请求状态与计数', async () => {
  const s = setup();
  s.listOrders.mockRejectedValueOnce(new Error('synthetic outage'));
  await expect(handleManualSyncJob(job(MANUAL_SYNC_RETRY_LIMIT), s.deps)).rejects.toThrow(
    'synthetic outage',
  );
  expect(s.requests.fail).not.toHaveBeenCalled();
  expect(s.requests.record).not.toHaveBeenCalled();
});

it('[AC-B1-09i#u3] 最后一次尝试失败（将进死信）时先把请求记 failed（含已被别的窗口记 done 的），再抛出', async () => {
  const s = setup();
  s.listOrders.mockRejectedValueOnce(new Error('synthetic outage'));
  await expect(handleManualSyncJob(job(MANUAL_SYNC_RETRY_LIMIT + 1), s.deps)).rejects.toThrow(
    'synthetic outage',
  );
  expect(s.requests.fail).toHaveBeenCalledWith('unit', SYNC, 'retries_exhausted', {
    overDone: true,
  });
  expect(s.requests.record).not.toHaveBeenCalled();
});

it('[AC-B1-09i#u4] retryLimit 可注入：按注入值判定最后一次', async () => {
  const s = setup();
  s.listOrders.mockRejectedValueOnce(new Error('synthetic outage'));
  await expect(handleManualSyncJob(job(2), { ...s.deps, retryLimit: 1 })).rejects.toThrow();
  expect(s.requests.fail).toHaveBeenCalledWith('unit', SYNC, 'retries_exhausted', {
    overDone: true,
  });
});

it('[AC-B1-09i#u5] 熔断关闭时照常拉取并回写计数', async () => {
  const s = setup();
  await handleManualSyncJob(job(1, true), s.deps);
  expect(s.listOrders).toHaveBeenCalledTimes(1);
  expect(s.requests.start).toHaveBeenCalledWith('unit', SYNC);
  expect(s.requests.record).toHaveBeenCalledWith('unit', SYNC, { fetched: 0, stored: 0 }, true);
  expect(s.requests.fail).not.toHaveBeenCalled();
});
