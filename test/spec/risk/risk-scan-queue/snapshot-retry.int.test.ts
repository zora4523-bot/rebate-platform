// B1-03w orders-side rule test on the real queue runtime and a real PostgreSQL (ruling D10-343 ①):
// the snapshot compensation scheduler's send is accepted by platform/queue — the job row exists in
// pgboss.job under order-sync with the name `snapshot_retry` and the key `snapshot-retry:<app>`
// (orchestrator §9.2) — and the worker's order-sync handler of createOrderSyncRuntime (production
// QUEUE_CATALOG and ENTRY_PLAN, entry worker) consumes it with the compensation scan. The test
// database is created here (`createTestDatabase()` of @couli/db/testing, ADR-0001 §4.2 #9);
// connections are the business role couli_app, as the worker entry's. Top-level it() only.
import { randomBytes } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { createSnapshotRetryScheduler } from '../../../../apps/api/src/modules/orders/jobs/snapshot-retry.ts';
import { createOrderSyncRuntime } from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import { createQueueRuntime } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { linesOf, memoryLogger } from './kit.ts';
import { until } from './int-kit.ts';
import { ORDER_SYNC, SNAPSHOT_RETRY, orderRuntimeDeps, snapshotKey } from './orders-kit.ts';

interface OrderJobRow {
  readonly job: string;
  readonly singletonKey: string | null;
  readonly state: string;
  readonly payload: unknown;
}

/** Every job of the order-sync queue, by job name then key (byte order). */
async function orderSyncJobs(observer: Kysely<DB>): Promise<OrderJobRow[]> {
  const result = await sql<{
    job: string;
    singleton_key: string | null;
    state: string;
    payload: unknown;
  }>`
    SELECT data->>'name' AS job, singleton_key, state::text AS state, data->'payload' AS payload
    FROM pgboss.job WHERE name = ${ORDER_SYNC}
    ORDER BY data->>'name' COLLATE "C", singleton_key COLLATE "C"
  `.execute(observer);
  return result.rows.map((row) => ({
    job: row.job,
    singletonKey: row.singleton_key,
    state: row.state,
    payload: row.payload,
  }));
}

/** Parsed log lines carrying `event` (the orders module logs flat `event` fields). */
function events(lines: readonly string[], event: string) {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['event'] === event);
}

it('[B1-03w#10] 快照补偿调度器的发送被真实队列接受（order-sync 里出现 snapshot_retry 任务、key 为 snapshot-retry:<app>），worker 的 order-sync 处理器把它交给补偿扫描并完成，不记 snapshot_retry_dispatch_failed / job_failed', async () => {
  const appId = `snapq-${randomBytes(8).toString('hex')}`;
  const database = await createTestDatabase();
  try {
    const base = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
    try {
      const now = (await sql<{ now: Date }>`SELECT now() AS now`.execute(base)).rows[0]!.now;
      const { logger, lines } = memoryLogger();
      const runtime = createQueueRuntime({ entry: 'worker', db: base, logger });
      // Registers the order-sync handler on the runtime, as OrdersModule.forWorker does.
      createOrderSyncRuntime(
        orderRuntimeDeps({ db: base, queue: runtime, logger, at: now.toISOString() }),
      );
      await runtime.start();
      try {
        const running = createSnapshotRetryScheduler({
          queue: runtime,
          listAppIds: async () => [appId],
          intervalMs: 500,
          logger,
        }).start();
        // Stop dispatching once a round has landed; a round already in flight may add one more.
        const landed = async () => (await orderSyncJobs(base)).length > 0;
        const sent = await until(landed, 40).finally(() => running.stop());
        const settled = await until(async () => {
          const jobs = await orderSyncJobs(base);
          return jobs.length > 0 && jobs.every((job) => job.state === 'completed');
        });
        const jobs = await orderSyncJobs(base);
        const scans = events(lines, 'snapshot_retry_scan');
        expect({
          sent,
          settled,
          // Distinct row shapes: every round's job is the same accepted, completed scan.
          jobs: [...new Set(jobs.map((job) => JSON.stringify(job)))].map(
            (job) => JSON.parse(job) as unknown,
          ),
          scanned: scans.length > 0,
          scans: [
            ...new Set(
              scans.map((line) => `${String(line['app_id'])} ${String(line['candidates'])}`),
            ),
          ],
          dispatchFailures: events(lines, 'snapshot_retry_dispatch_failed'),
          jobFailures: linesOf(lines, ['job_failed', 'job_failed_final']),
        }).toEqual({
          sent: true,
          settled: true,
          jobs: [
            {
              job: SNAPSHOT_RETRY,
              singletonKey: snapshotKey(appId),
              state: 'completed',
              payload: { app_id: appId },
            },
          ],
          scanned: true,
          scans: [`${appId} 0`],
          dispatchFailures: [],
          jobFailures: [],
        });
      } finally {
        await runtime.stop();
      }
    } finally {
      await destroyDb(base).catch(() => undefined);
    }
  } finally {
    await database.drop();
  }
}, 180_000);
