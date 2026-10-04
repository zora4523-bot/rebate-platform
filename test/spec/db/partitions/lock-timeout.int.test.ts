// Rule test for the lock wait of app.drop_expired_month_partitions (B1-01j, code review round 1).
// Basis: ADR-0001 §4.2 #4 (worker 定时任务以 couli_maint 删分区), #16 (event_log 与业务写入同一事务写入);
// 规划/02 §15.1. Deleting a partition needs exclusive locks; while such a request waits, every later
// writer of event_log queues behind it, so an unbounded wait behind one long read transaction would
// stall all business writes that record domain events.
//
// Contract supplement (adds to section A1 of apps/api/src/modules/platform/maintenance/index.ts):
//   - The function carries exactly these function-level settings, in this order (pg_proc.proconfig):
//     search_path=pg_catalog, pg_temp; lock_timeout=5s; DateStyle=ISO, YMD; TimeZone=UTC
//     (DateStyle and TimeZone fix how partition bounds are rendered and parsed, independent of the
//     caller's session).
//   - When a lock it needs is not granted within 5 s, the call fails with SQLSTATE 55P03
//     (lock_not_available); the whole statement rolls back (nothing dropped, nothing reported), and
//     no lock request of it stays queued. The maintenance run logs it as partition_drop_failed with
//     sqlstate '55P03' and tries again on its next run (section C.4).
//   - Consequence checked here: a read transaction on event_log that stays open makes the call fail
//     after about 5 s instead of waiting, and an insert into the current month partition issued
//     while the call waits completes within that bound plus a margin.
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { connect, disconnect, dropExpired, ensureMonths, outcome, partitionNames } from './kit.ts';

/** Elapsed milliseconds of `run`, with how it ended (see `outcome`). */
async function timed(run: Promise<unknown>): Promise<{ ms: number; result: string }> {
  const t0 = performance.now();
  const result = await outcome(run);
  return { ms: performance.now() - t0, result };
}

it('[ADR-0001 §4.2 #4、#16; contract A1 lock_timeout] 另一连接的读事务一直持有 event_log 的 ACCESS SHARE 锁时调用删除：4–9 秒内以 55P03 失败、什么都不删；其间向当月分区插入的一行在 9 秒内写成', async () => {
  const database = await createTestDatabase();
  const roles = connect(database);
  const reader = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  const writer = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  const observer = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  let releaseReader: () => void = () => undefined;
  const readerReleased = new Promise<void>((resolve) => {
    releaseReader = resolve;
  });
  let readerReady: () => void = () => undefined;
  const readerHolds = new Promise<void>((resolve) => {
    readerReady = resolve;
  });
  let reading: Promise<unknown> = Promise.resolve();
  try {
    await ensureMonths(roles.maint, 'event_log', ['2026-03', '2026-10']);
    reading = reader.transaction().execute(async (trx) => {
      await sql`SELECT count(*) FROM app.event_log`.execute(trx);
      readerReady();
      await readerReleased;
    });
    await readerHolds;

    const dropping = timed(dropExpired(roles.maint, 'event_log', '2026-10-08T20:00:00.000Z'));
    // Wait until the drop call is queued on a lock (a couli_maint session of this database).
    let queued = false;
    for (let i = 0; i < 100 && !queued; i += 1) {
      const r = await sql<{ n: string }>`
        SELECT count(*)::text AS n
        FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted AND a.usename = 'couli_maint'
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `.execute(observer);
      queued = r.rows[0]?.n !== '0';
      if (!queued) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const writing = timed(
      sql`
        INSERT INTO app.event_log (app_id, event_id, name, payload, occurred_at)
        VALUES ('couli', '00000000-0000-7000-8000-0000000d0001'::uuid, 'order.created',
                '{"order_id": "x"}'::jsonb, '2026-10-05T00:00:00Z'::timestamptz)
      `.execute(writer),
    );
    // Give the drop call 12 s at most; past that it counts as still waiting.
    const limit = new Promise<{ ms: number; result: string }>((resolve) => {
      setTimeout(() => resolve({ ms: 12_000, result: 'still waiting after 12 s' }), 12_000);
    });
    const drop = await Promise.race([dropping, limit]);
    const write = await Promise.race([writing, limit]);
    releaseReader();
    await reading;
    // Both calls end once the reader is gone; awaited so that nothing runs during the cleanup.
    await Promise.all([dropping, writing]);
    expect({
      queued,
      dropCode: drop.result.split(' ')[0],
      dropWithinBound: drop.ms >= 4_000 && drop.ms <= 9_000,
      writeResult: write.result,
      writeWithinBound: write.ms <= 9_000,
    }).toEqual({
      queued: true,
      dropCode: '55P03',
      dropWithinBound: true,
      writeResult: 'ok',
      writeWithinBound: true,
    });
    expect(await partitionNames(roles.maint, 'event_log')).toEqual([
      'event_log_default',
      'event_log_p202603',
      'event_log_p202610',
    ]);
    const rows = await sql<{ part: string }>`
      SELECT tableoid::regclass::text AS part FROM app.event_log
    `.execute(observer);
    expect(rows.rows.map((r) => r.part)).toEqual(['app.event_log_p202610']);
  } finally {
    releaseReader();
    await reading.catch(() => undefined);
    await Promise.all([reader, writer, observer].map((db) => destroyDb(db).catch(() => undefined)));
    await disconnect(roles);
    await database.drop();
  }
}, 60_000);
