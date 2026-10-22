import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  createQueueRuntime,
  QUEUE_CATALOG,
  type QueueRuntime,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { waitFor } from '../queue/kit.ts';
import { alerts, BUSINESS_QUEUES, capture, insertJob } from './kit.ts';

it('[AC-B1-01zzg#4] 迁移在应用启动前已建各 .dead 并改业务 dead_letter，目录一致且五入口均可启动', async () => {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 3 });
  const runtimes: QueueRuntime[] = [];
  try {
    // Inspect the migrated template BEFORE runtime.start can create/update any queue.
    const rows = (
      await sql<{ name: string; dead_letter: string | null }>`
      SELECT name, dead_letter FROM pgboss.queue
    `.execute(db)
    ).rows;
    for (const name of BUSINESS_QUEUES) {
      expect(rows.filter((row) => row.name === `${name}.dead`)).toEqual([
        { name: `${name}.dead`, dead_letter: null },
      ]);
      // A fresh database can have no business queue yet; migration updates existing sources,
      // while runtime is still allowed to create missing business queues at startup.
      for (const source of rows.filter((row) => row.name === name)) {
        expect(source.dead_letter).toBe(`${name}.dead`);
      }
    }
    expect(rows.filter((row) => row.dead_letter === 'dead-letter')).toEqual([]);
    for (const entry of ['api', 'stream', 'admin', 'payout', 'worker'] as const) {
      const runtime = createQueueRuntime({ entry, db, logger: capture().logger });
      runtimes.push(runtime);
      await expect(runtime.start()).resolves.toBeUndefined();
      await runtime.stop();
    }
    const startedRows = (
      await sql<{ name: string; dead_letter: string | null }>`
      SELECT name, dead_letter FROM pgboss.queue
    `.execute(db)
    ).rows;
    for (const spec of QUEUE_CATALOG.filter((q) => q.deadLetter !== null)) {
      expect(startedRows.find((row) => row.name === spec.name)?.dead_letter).toBe(spec.deadLetter);
      expect(spec.deadLetter).toBe(`${spec.name}.dead`);
    }
  } finally {
    for (const runtime of runtimes) await runtime.stop();
    await destroyDb(db);
    await database.drop();
  }
});

it('[AC-B1-01zzg#5] 只有 worker 登记五分钟 pg-boss schedule，定时队列任务实际触发 SQL 告警且死信原样保留', async () => {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 5 });
  const runtimes: QueueRuntime[] = [];
  const { logger, lines } = capture();
  const schedules = async () =>
    (
      await sql<{ name: string; cron: string }>`
    SELECT name, cron FROM pgboss.schedule WHERE name = 'dead-letter-scan'
  `.execute(db)
    ).rows;
  // Observe the real cron monitor stamp: a schedule row alone cannot detect schedule:false.
  const cronRan = async () =>
    (
      await sql<{ ran: boolean }>`
      SELECT cron_on IS NOT NULL AS ran FROM pgboss.version
    `.execute(db)
    ).rows[0]?.ran === true;
  try {
    await sql`UPDATE pgboss.version SET cron_on = NULL`.execute(db);
    for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
      const runtime = createQueueRuntime({ entry, db, logger });
      runtimes.push(runtime);
      await runtime.start();
      expect(await cronRan()).toBe(false);
      expect(await schedules()).toEqual([]);
      await runtime.stop();
    }
    const worker = createQueueRuntime({ entry: 'worker', db, logger });
    runtimes.push(worker);
    await worker.start();
    expect(await schedules()).toEqual([{ name: 'dead-letter-scan', cron: '*/5 * * * *' }]);
    expect(await waitFor(cronRan, 10_000)).toBe(true);
    await insertJob(db, 'notify.dead', { detail: 'preserve-this-row' });
    await insertJob(db, 'order-sync.dead', { platform: 'pdd' });
    const deadRows = async () =>
      (
        await sql`
      SELECT to_jsonb(j) AS row FROM pgboss.job j
      WHERE name IN ('notify.dead', 'order-sync.dead') ORDER BY name, id
    `.execute(db)
      ).rows;
    const before = await deadRows();
    lines.length = 0;
    // Deliver the scheduled job without waiting five real minutes; this tests the production
    // worker registration, not merely a direct call of the scan helper.
    await insertJob(db, 'dead-letter-scan', { name: 'dead-letter.scan', payload: {} });
    expect(await waitFor(() => alerts(lines).length >= 2, 10_000)).toBe(true);
    expect(alerts(lines)).toEqual([
      { queue: 'notify.dead', count: 1 },
      { queue: 'order-sync.dead', platform: 'pdd', count: 1 },
    ]);
    expect(await deadRows()).toEqual(before);
    await worker.stop();
    // Restart must upsert the same schedule, rather than accumulating duplicate ticks.
    const restarted = createQueueRuntime({ entry: 'worker', db, logger });
    runtimes.push(restarted);
    await restarted.start();
    expect(await schedules()).toEqual([{ name: 'dead-letter-scan', cron: '*/5 * * * *' }]);
  } finally {
    for (const runtime of runtimes) await runtime.stop();
    await destroyDb(db);
    await database.drop();
  }
}, 30_000);
