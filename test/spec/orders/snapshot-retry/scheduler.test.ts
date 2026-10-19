import { afterEach, expect, it, vi } from 'vitest';
import {
  createSnapshotRetryScheduler,
  type SnapshotRetrySchedulerDeps,
} from '../../../../apps/api/src/modules/orders/jobs/snapshot-retry.ts';

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  const send = vi
    .fn<SnapshotRetrySchedulerDeps['queue']['send']>()
    .mockResolvedValue('synthetic-job');
  const listAppIds = vi
    .fn<SnapshotRetrySchedulerDeps['listAppIds']>()
    .mockResolvedValue(['app-a', 'app-b']);
  const deps: SnapshotRetrySchedulerDeps = {
    queue: { send },
    listAppIds,
    intervalMs: 60_000,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { send, listAppIds, deps };
}

it('[AC-B1-08t#22] 定时器通过 JobQueue 按 App 投递补偿扫描，停止后不再投递', async () => {
  const f = fixture();
  const scheduler = createSnapshotRetryScheduler(f.deps);
  expect(f.send).not.toHaveBeenCalled();
  const running = scheduler.start();
  try {
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls.map(([queue, name, payload]) => ({ queue, name, payload }))).toEqual([
      { queue: 'order-sync', name: 'snapshot-retry', payload: { app_id: 'app-a' } },
      { queue: 'order-sync', name: 'snapshot-retry', payload: { app_id: 'app-b' } },
    ]);
    for (const [, , , options] of f.send.mock.calls) expect(options.trx).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.send).toHaveBeenCalledTimes(4);
  } finally {
    await running.stop();
  }
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.send).toHaveBeenCalledTimes(4);
});

it('[AC-B1-08t#23] 某轮读取失败不会永久停止补偿扫描', async () => {
  const f = fixture();
  f.listAppIds.mockRejectedValueOnce(new Error('synthetic app listing failed'));
  const running = createSnapshotRetryScheduler(f.deps).start();
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.send).toHaveBeenCalledTimes(2);
  } finally {
    await running.stop();
  }
});
