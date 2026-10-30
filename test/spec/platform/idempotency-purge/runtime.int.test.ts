// Rule tests of the worker runtime's internal purge schedule against a real PostgreSQL (B1-15za;
// contract sections 2 and 3 of apps/api/src/modules/platform/queue/idempotency-purge.ts; 08 BR-ID-30
// ⑤; built after test/spec/platform/dead-letter-scan/runtime.int.test.ts). The cron cannot wait for
// 04:00, so a tick is delivered by inserting the job the schedule row describes (./kit.ts). Connected
// as couli_app. Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createIdempotency } from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import { scheduleIdempotencyPurge } from '../../../../apps/api/src/modules/platform/queue/idempotency-purge.ts';
import {
  createQueueRuntime,
  type QueueRuntime,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { deadCopies, jobRows } from '../queue/int-kit.ts';
import { memoryLogger, waitFor } from '../queue/kit.ts';
import {
  NOW,
  PURGED,
  QUEUE,
  RESPONSE_MARKER,
  SCHEDULE_ROW,
  deliverTick,
  insertKey,
  leftKeys,
  linesOf,
  purgeQueues,
  purgeSchedules,
  purgedLine,
  seedKeys,
} from './kit.ts';

it('[AC-B1-15za#1] 只有 worker 运行时登记 cron 0 20 * * *（UTC）；api、stream、admin、payout 交给它也不建队列不登记；worker 重启后仍是同一条，不累积，dead-letter-scan 不受影响', async () => {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 5 });
  const runtimes: QueueRuntime[] = [];
  const { logger } = memoryLogger('worker');
  const idempotency = { purgeExpired: vi.fn(async () => 0) };
  try {
    for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
      const runtime = createQueueRuntime({ entry, db, logger });
      runtimes.push(runtime);
      scheduleIdempotencyPurge(runtime, idempotency);
      await runtime.start();
      expect(await purgeSchedules(db)).toEqual([]);
      expect(await purgeQueues(db)).toEqual([]);
      await runtime.stop();
    }
    for (let start = 0; start < 2; start += 1) {
      const worker = createQueueRuntime({ entry: 'worker', db, logger });
      runtimes.push(worker);
      scheduleIdempotencyPurge(worker, idempotency);
      await worker.start();
      expect(await purgeSchedules(db)).toEqual([SCHEDULE_ROW]);
      await worker.stop();
    }
    const scan = await sql`
      SELECT cron FROM pgboss.schedule WHERE name = 'dead-letter-scan'
    `.execute(db);
    expect(scan.rows).toEqual([{ cron: '*/5 * * * *' }]);
  } finally {
    for (const runtime of runtimes) await runtime.stop();
    await destroyDb(db);
    await database.drop();
  }
}, 60_000);

it('[AC-B1-15za#2] 定时任务触发后按注入时钟删 expire_at 已过的行，三种状态一视同仁；恰好到期、未到期、infinity（提现与收款账号）的行保留；日志只有删除行数，没有键、请求或响应内容', async () => {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 5 });
  const runtimes: QueueRuntime[] = [];
  const { logger, lines } = memoryLogger('worker');
  try {
    const { gone, kept } = await seedKeys(db, NOW);
    await insertKey(db, { key: 'purge_exactly_now', status: 'completed', expire: NOW });
    const worker = createQueueRuntime({ entry: 'worker', db, logger });
    runtimes.push(worker);
    scheduleIdempotencyPurge(worker, createIdempotency({ db, clock: new FixedClock(NOW), logger }));
    await worker.start();
    expect(await deliverTick(db)).toHaveLength(1);
    expect(await waitFor(() => linesOf(lines, PURGED).length > 0, 15_000)).toBe(true);
    expect(linesOf(lines, PURGED)).toEqual([purgedLine(gone.length)]);
    expect(await leftKeys(db)).toEqual([...kept, 'purge_exactly_now'].sort());
    const logged = lines.join('\n');
    for (const key of [...gone, ...kept]) expect(logged).not.toContain(key);
    expect(logged).not.toContain(RESPONSE_MARKER);
    expect(logged).not.toContain('request_hash');
  } finally {
    for (const runtime of runtimes) await runtime.stop();
    await destroyDb(db);
    await database.drop();
  }
}, 30_000);

it('[AC-B1-15za#3] 队列零重试无死信：一次失败的任务停在 failed、不重试、不进死信，错误内容不进日志；下一次触发照常清掉', async () => {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 5 });
  const runtimes: QueueRuntime[] = [];
  const { logger, lines } = memoryLogger('worker');
  try {
    const { gone, kept } = await seedKeys(db, NOW);
    const real = createIdempotency({ db, clock: new FixedClock(NOW), logger });
    const failure = new Error('purge-failure-detail');
    const purgeExpired = vi.fn(() => real.purgeExpired()).mockRejectedValueOnce(failure);
    const worker = createQueueRuntime({ entry: 'worker', db, logger });
    runtimes.push(worker);
    scheduleIdempotencyPurge(worker, { purgeExpired });
    await worker.start();
    expect(await purgeQueues(db)).toEqual([
      {
        policy: 'standard',
        retry_limit: 0,
        retry_backoff: false,
        dead_letter: null,
        partition: false,
      },
    ]);

    const state = async (id: string) => (await jobRows(db, id))[0]?.state;
    const [first] = await deliverTick(db);
    expect(first).toEqual(expect.any(String));
    expect(await waitFor(async () => (await state(first!)) === 'failed', 15_000)).toBe(true);
    expect(await jobRows(db, first!)).toMatchObject([{ state: 'failed', retryCount: 0 }]);
    expect(await deadCopies(db, first!)).toEqual([]);
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    expect(await leftKeys(db)).toEqual([...gone, ...kept].sort());
    expect(linesOf(lines, 'job_failed_final')).toEqual([
      {
        level: 50,
        entry: 'worker',
        env: 'test',
        queue: QUEUE,
        jobId: first,
        attempt: 1,
        jobName: expect.any(String),
        msg: 'job_failed_final',
      },
    ]);
    expect(linesOf(lines, PURGED)).toEqual([]);

    const [second] = await deliverTick(db);
    expect(second).toEqual(expect.any(String));
    expect(await waitFor(async () => (await state(second!)) === 'completed', 15_000)).toBe(true);
    expect(purgeExpired).toHaveBeenCalledTimes(2);
    expect(linesOf(lines, PURGED)).toEqual([purgedLine(gone.length)]);
    expect(await leftKeys(db)).toEqual([...kept].sort());
    expect(lines.join('\n')).not.toContain('purge-failure-detail');
  } finally {
    for (const runtime of runtimes) await runtime.stop();
    await destroyDb(db);
    await database.drop();
  }
}, 45_000);
