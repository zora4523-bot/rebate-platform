// B1-09i: the manual sync handler's breaker check and its per-job write-back (its row sync_seq).
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

function job(attempt: number, seq = 0): ReceivedJob {
  return {
    id: 'j1',
    queue: 'order-sync',
    name: 'manual_window',
    payload: {
      app_id: 'unit',
      platform: 'pdd',
      union_account_id: ACC,
      scene: '-',
      query_kind: 'increment',
      window_start: '2026-10-17T00:00:00.000Z',
      window_end: '2026-10-17T00:30:00.000Z',
      sync_id: SYNC,
      sync_seq: seq,
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
    finish: vi.fn<OrderSyncRequestProgress['finish']>().mockResolvedValue(undefined),
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

it('[AC-B1-09i#u1] worker 的离线熔断打开时取到任务不拉取，本窗与请求记 failed（offline_circuit_open）', async () => {
  const s = setup(true);
  await handleManualSyncJob(job(1, 2), s.deps);
  expect(s.offlineCircuitOpen).toHaveBeenCalledWith('pdd');
  expect(s.listOrders).not.toHaveBeenCalled();
  expect(s.requests.start).not.toHaveBeenCalled();
  expect(s.requests.finish).toHaveBeenCalledWith('unit', SYNC, 2, {
    status: 'failed',
    error: 'offline_circuit_open',
  });
});

it('[AC-B1-09i#u2] 未到最后一次的拉取失败只抛出交队列重试，不结束本窗、不计数', async () => {
  const s = setup();
  s.listOrders.mockRejectedValueOnce(new Error('synthetic outage'));
  await expect(handleManualSyncJob(job(MANUAL_SYNC_RETRY_LIMIT), s.deps)).rejects.toThrow(
    'synthetic outage',
  );
  expect(s.requests.finish).not.toHaveBeenCalled();
});

it('[AC-B1-09i#u3] 最后一次尝试失败（将进死信）时先把本窗记 failed（retries_exhausted），再抛出', async () => {
  const s = setup();
  s.listOrders.mockRejectedValueOnce(new Error('synthetic outage'));
  await expect(handleManualSyncJob(job(MANUAL_SYNC_RETRY_LIMIT + 1, 1), s.deps)).rejects.toThrow(
    'synthetic outage',
  );
  expect(s.requests.finish).toHaveBeenCalledTimes(1);
  expect(s.requests.finish).toHaveBeenCalledWith('unit', SYNC, 1, {
    status: 'failed',
    error: 'retries_exhausted',
  });
});

it('[AC-B1-09i#u4] retryLimit 可注入：按注入值判定最后一次', async () => {
  const s = setup();
  s.listOrders.mockRejectedValueOnce(new Error('synthetic outage'));
  await expect(handleManualSyncJob(job(2), { ...s.deps, retryLimit: 1 })).rejects.toThrow();
  expect(s.requests.finish).toHaveBeenCalledWith('unit', SYNC, 0, {
    status: 'failed',
    error: 'retries_exhausted',
  });
});

it('[AC-B1-09i#u5] 熔断关闭时照常拉取，按本窗编号开始与结束并写本窗计数', async () => {
  const s = setup();
  s.listOrders.mockResolvedValueOnce({ items: [{} as never, {} as never], nextCursor: null });
  vi.mocked(s.deps.pipeline.process)
    .mockResolvedValueOnce({ kind: 'inserted' } as never)
    .mockResolvedValueOnce({ kind: 'unchanged' } as never);
  await handleManualSyncJob(job(1, 3), s.deps);
  expect(s.listOrders).toHaveBeenCalledTimes(1);
  expect(s.requests.start).toHaveBeenCalledWith('unit', SYNC, 3);
  expect(s.requests.finish).toHaveBeenCalledTimes(1);
  expect(s.requests.finish).toHaveBeenCalledWith('unit', SYNC, 3, {
    status: 'done',
    fetched: 2,
    stored: 1,
  });
});

it('[AC-B1-09i#u6] 载荷缺 sync_seq 或不是非负整数时拒绝（不拉取、不回写）', async () => {
  for (const seq of [undefined, -1, 1.5, '0']) {
    const s = setup();
    const bad = job(1);
    const payload = { ...bad.payload } as Record<string, unknown>;
    if (seq === undefined) delete payload['sync_seq'];
    else payload['sync_seq'] = seq;
    await expect(
      handleManualSyncJob({ ...bad, payload: payload as ReceivedJob['payload'] }, s.deps),
    ).rejects.toThrow('invalid sync_seq');
    expect(s.listOrders).not.toHaveBeenCalled();
    expect(s.requests.finish).not.toHaveBeenCalled();
  }
});

it('[AC-B1-09i#u10] 请求已 done（各窗都已结束）时重投的任务不拉取、不回写', async () => {
  const s = setup();
  s.requests.status.mockResolvedValue('done');
  await handleManualSyncJob(job(1, 1), s.deps);
  expect(s.listOrders).not.toHaveBeenCalled();
  expect(s.requests.start).not.toHaveBeenCalled();
  expect(s.requests.finish).not.toHaveBeenCalled();
});
