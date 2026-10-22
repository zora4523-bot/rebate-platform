import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { scanDeadLetters } from '../../../../apps/api/src/modules/platform/queue/dead-letter-scan.ts';
import { alerts, BUSINESS_QUEUES, capture, insertJob, jobSnapshot, prepareQueues } from './kit.ts';

it('[AC-B1-01zzg#2] SQL 扫所有 .dead；order-sync 按 data.platform 分组，零计数不告警，不取走、不修改、不重放任务', async () => {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  try {
    const dead = BUSINESS_QUEUES.map((q) => `${q}.dead`);
    await prepareQueues(db, [...dead, 'extension-job.dead', 'notify', 'order-sync', 'decoy-dead']);
    const expected: { queue: string; platform?: string; count: number }[] = [];
    for (const queue of dead.filter((q) => q !== 'order-sync.dead' && q !== 'export.dead')) {
      await insertJob(db, queue, { platform: 'irrelevant', detail: 'do-not-log-payload' });
      await insertJob(db, queue, { platform: 'different' });
      expected.push({ queue, count: 2 });
    }
    // Must discover .dead queues in SQL, rather than only a hard-coded list of known names.
    await insertJob(db, 'extension-job.dead', {});
    expected.push({ queue: 'extension-job.dead', count: 1 });
    await insertJob(db, 'order-sync.dead', { platform: 'pdd' });
    await insertJob(db, 'order-sync.dead', { platform: 'pdd' });
    await insertJob(db, 'order-sync.dead', { platform: 'jd' });
    // Existing JobQueue wraps the original payload. Actual dead copies must retain attribution.
    await insertJob(db, 'order-sync.dead', { name: 'sync.window', payload: { platform: 'jd' } });
    await insertJob(db, 'order-sync.dead', {});
    expected.push(
      { queue: 'order-sync.dead', platform: 'pdd', count: 2 },
      { queue: 'order-sync.dead', platform: 'jd', count: 2 },
      { queue: 'order-sync.dead', count: 1 },
    );
    // A failed source job and a lookalike name are not dead-queue rows.
    await insertJob(db, 'notify', {}, 'failed');
    await insertJob(db, 'order-sync', { platform: 'pdd' }, 'failed');
    await insertJob(db, 'decoy-dead', {});
    const before = await jobSnapshot(db);
    const { logger, lines, clock } = capture();
    await db.transaction().execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      await expect(scanDeadLetters({ db: trx, logger, clock })).resolves.toBeUndefined();
      expect(alerts(lines)).toEqual(
        expected.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      );
      expect(JSON.stringify(lines)).not.toContain('do-not-log-payload');
      expect(await jobSnapshot(trx)).toEqual(before);
      // A second scan sees the same jobs: the first pass did not consume them.
      lines.length = 0;
      clock.advanceMs(300_000);
      await expect(scanDeadLetters({ db: trx, logger, clock })).resolves.toBeUndefined();
      expect(alerts(lines)).toEqual(expected);
      expect(await jobSnapshot(trx)).toEqual(before);
    });
  } finally {
    await destroyDb(db);
    await database.drop();
  }
});

it('[AC-B1-01zzg#3] 所有死信队列为空时静默，业务队列 failed 不冒充死信计数', async () => {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  try {
    await prepareQueues(db, [...BUSINESS_QUEUES.map((q) => `${q}.dead`), 'notify']);
    await insertJob(db, 'notify', { platform: 'pdd' }, 'failed');
    const before = await jobSnapshot(db);
    const { logger, lines, clock } = capture();
    await db.transaction().execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      await expect(scanDeadLetters({ db: trx, logger, clock })).resolves.toBeUndefined();
    });
    expect(alerts(lines)).toEqual([]);
    expect(await jobSnapshot(db)).toEqual(before);
  } finally {
    await destroyDb(db);
    await database.drop();
  }
});
