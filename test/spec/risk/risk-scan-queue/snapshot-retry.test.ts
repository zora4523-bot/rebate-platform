// B1-03w orders-side rule tests without a database (ruling D10-343 ①): the order snapshot
// compensation scan's dispatch (createSnapshotRetryScheduler, every round through JobQueue onto
// order-sync) goes through a queue double applying platform/queue's own validateSend against the
// production order-sync entry — what QueueRuntime.send checks before it touches the database — and
// must be accepted under the name `snapshot_retry` with the readable key `snapshot-retry:<app>`
// (orchestrator §9.2). The worker's order-sync handler (createOrderSyncRuntime) must route a
// `snapshot_retry` job to the compensation scan, not to the window handler. The real runtime and
// database: ./snapshot-retry.int.test.ts.
import { afterEach, expect, it, vi } from 'vitest';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  SNAPSHOT_RETRY_JOB,
  createSnapshotRetryScheduler,
} from '../../../../apps/api/src/modules/orders/jobs/snapshot-retry.ts';
import { createOrderSyncRuntime } from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import { linesOf, memoryLogger, settle } from './kit.ts';
import {
  ORDER_SYNC,
  SNAPSHOT_RETRY,
  loggedDb,
  orderRuntimeDeps,
  snapshotKey,
  validatingOrderQueue,
} from './orders-kit.ts';

const databases: Kysely<DB>[] = [];
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

/** Parsed log lines carrying `event` (the orders module logs flat `event` fields). */
function events(lines: readonly string[], event: string) {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['event'] === event);
}

it('[B1-03w#8] 快照补偿调度器每轮经 JobQueue 的发送过 platform/queue 的 validateSend：order-sync 队列、任务名恰为 snapshot_retry、singletonKey 保持 snapshot-retry:<app>，不记 snapshot_retry_dispatch_failed', async () => {
  vi.useFakeTimers();
  const { logger, lines } = memoryLogger();
  const q = validatingOrderQueue();
  const running = createSnapshotRetryScheduler({
    queue: q.queue,
    listAppIds: async () => ['app-a', 'app-b'],
    intervalMs: 60_000,
    logger,
  }).start();
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
  } finally {
    await running.stop();
  }
  expect({
    constant: SNAPSHOT_RETRY_JOB,
    sends: q.sends.map((sent) => ({
      queue: sent.queue,
      name: sent.name,
      payload: sent.payload,
      singletonKey: sent.singletonKey,
      trx: sent.trx,
      outcome: sent.outcome,
    })),
    failures: events(lines, 'snapshot_retry_dispatch_failed'),
  }).toEqual({
    constant: SNAPSHOT_RETRY,
    sends: [1, 2].flatMap(() =>
      ['app-a', 'app-b'].map((appId) => ({
        queue: ORDER_SYNC,
        name: SNAPSHOT_RETRY,
        payload: { app_id: appId },
        singletonKey: snapshotKey(appId),
        trx: null,
        outcome: 'accepted',
      })),
    ),
    failures: [],
  });
});

it('[B1-03w#9] worker 的 order-sync 处理器把 snapshot_retry 任务分派到补偿扫描（查待处理订单、记 snapshot_retry_scan），不当作窗口任务解析失败', async () => {
  const queries: string[] = [];
  const db = loggedDb(queries);
  databases.push(db);
  const { logger, lines } = memoryLogger();
  const q = validatingOrderQueue();
  const built = await settle(
    Promise.resolve().then(() =>
      createOrderSyncRuntime(
        orderRuntimeDeps({ db, queue: q.queue, logger, at: '2026-10-17T17:30:00.000Z' }),
      ),
    ),
  );
  expect(built).toBe('resolved');
  const handlers = q.handlers.filter(([queue]) => queue === ORDER_SYNC);
  expect(handlers).toHaveLength(1);
  const handled = await settle(
    handlers[0]![1]({
      id: 'synthetic-snapshot-retry',
      queue: ORDER_SYNC,
      name: SNAPSHOT_RETRY,
      payload: { app_id: 'app-a' },
      attempt: 1,
    }),
  );
  expect({
    handled,
    scans: events(lines, 'snapshot_retry_scan').map((line) => ({
      app_id: line['app_id'],
      candidates: line['candidates'],
    })),
    queried: queries.some((query) => query.includes('order_sync_pending')),
    sends: q.sends,
    failures: linesOf(lines, ['job_failed', 'job_failed_final']),
  }).toEqual({
    handled: 'resolved',
    scans: [{ app_id: 'app-a', candidates: 0 }],
    queried: true,
    sends: [],
    failures: [],
  });
});
