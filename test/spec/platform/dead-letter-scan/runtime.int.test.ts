import { readdirSync, readFileSync } from 'node:fs';
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

it('[AC-B1-01zzg#10] 已部署旧目录整段重放迁移后，各业务队列改指自己的 .dead 且五入口均可启动', async () => {
  const directory = new URL('../../../../db/migrations/', import.meta.url);
  const files = readdirSync(directory).filter((name) => name.endsWith('_queue-dead-letters.sql'));
  // Fail by assertion before opening a database when the implementation migration is absent.
  expect(files, '本任务迁移须唯一，以 _queue-dead-letters.sql 结尾，序号由落地时分配').toHaveLength(
    1,
  );
  const source = readFileSync(new URL(files[0]!, directory), 'utf8');
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 3 });
  const runtimes: QueueRuntime[] = [];
  try {
    // Reconstruct the deployed catalog independently of the new catalog under test.
    await sql`SELECT pgboss.create_queue('dead-letter', ${JSON.stringify({
      policy: 'standard',
      retryLimit: 0,
      retryDelay: 1,
      retryBackoff: false,
      expireInSeconds: 900,
      retentionSeconds: 2_592_000,
      deleteAfterSeconds: 2_592_000,
    })}::jsonb)`.execute(db);
    for (const name of BUSINESS_QUEUES) {
      await sql`SELECT pgboss.create_queue(${name}, ${JSON.stringify({
        policy: ['order-sync', 'settle', 'payout', 'risk-scan', 'union-auth', 'pay'].includes(name)
          ? 'exclusive'
          : 'standard',
        retryLimit: 5,
        retryDelay: 10,
        retryBackoff: true,
        retryDelayMax: 600,
        expireInSeconds: 900,
        retentionSeconds: 1_209_600,
        deleteAfterSeconds: 604_800,
        deadLetter: 'dead-letter',
      })}::jsonb)`.execute(db);
      // The template already ran all migrations; reset any pre-created source queue too.
      await sql`UPDATE pgboss.queue SET dead_letter = 'dead-letter' WHERE name = ${name}`.execute(
        db,
      );
    }
    const deadNames = BUSINESS_QUEUES.map((name) => `${name}.dead`);
    // Remove the template's targets so updating sources before creating targets violates
    // the real FK. Only this isolated test database is changed; no runtime has started.
    await sql`DELETE FROM pgboss.queue WHERE name IN (${sql.join(deadNames)})`.execute(db);
    const businessRows = async () =>
      (
        await sql<{ name: string; dead_letter: string | null }>`
        SELECT name, dead_letter FROM pgboss.queue
        WHERE name IN (${sql.join(BUSINESS_QUEUES)}) ORDER BY name
      `.execute(db)
      ).rows;
    const names = [...BUSINESS_QUEUES].sort();
    expect(await businessRows()).toEqual(
      names.map((name) => ({ name, dead_letter: 'dead-letter' })),
    );
    expect(
      (await sql`SELECT name FROM pgboss.queue WHERE name IN (${sql.join(deadNames)})`.execute(db))
        .rows,
    ).toEqual([]);

    // Replay the complete migration, including SET LOCAL, rather than a test-owned UPDATE.
    await db.transaction().execute(async (trx) => {
      await sql.raw(source).execute(trx);
    });
    // Check before runtime.start: startup cannot conceal an omitted migration UPDATE.
    expect(await businessRows()).toEqual(
      names.map((name) => ({ name, dead_letter: `${name}.dead` })),
    );
    const targets = (
      await sql<{ name: string; dead_letter: string | null }>`
      SELECT name, dead_letter FROM pgboss.queue
      WHERE name IN (${sql.join(deadNames)}) ORDER BY name
    `.execute(db)
    ).rows;
    expect(targets).toEqual([...deadNames].sort().map((name) => ({ name, dead_letter: null })));
    for (const name of BUSINESS_QUEUES) {
      expect(QUEUE_CATALOG.filter((spec) => spec.name === name)).toEqual([
        expect.objectContaining({ name, deadLetter: `${name}.dead` }),
      ]);
    }
    for (const entry of ['api', 'stream', 'admin', 'payout', 'worker'] as const) {
      const runtime = createQueueRuntime({ entry, db, logger: capture().logger });
      runtimes.push(runtime);
      await expect(runtime.start()).resolves.toBeUndefined();
      await runtime.stop();
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
    // Deliver the registered schedule's exact data (including null) without waiting five
    // real minutes. A test-invented envelope could conceal an incompatible schedule payload.
    const delivered = await sql`
      INSERT INTO pgboss.job (name, data)
      SELECT name, data FROM pgboss.schedule WHERE name = 'dead-letter-scan'
      RETURNING id
    `.execute(db);
    expect(delivered.rows).toHaveLength(1);
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
