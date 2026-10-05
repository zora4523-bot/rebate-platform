// Rule tests for the lock waits of the day-partition functions (B1-01s; contract section I1 in
// apps/api/src/modules/platform/maintenance/index.ts, "Locks"). Basis: ADR-0001 §4.2 #4 (worker 定时
// 任务以 couli_maint 建和删分区); BR-ID-30 ② (link_logs 按日分区删除). A DDL lock request that waits makes
// every later writer of the table queue behind it (link_logs is written by every convert / open
// request, BR-ATTR-14); so each wait is bounded by the function's lock_timeout of 5 s, and a call
// that has nothing to create or drop requests no table lock at all.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import { dayNames, dayRange, dropDays, ensureDays, insertLinkLog, linkLogRows } from './day-kit.ts';
import { connect, disconnect, partitionNames, type Roles } from './kit.ts';

/** Elapsed milliseconds of `run` with its result. */
async function timed<T>(run: Promise<T>): Promise<{ ms: number; result: T }> {
  const t0 = performance.now();
  const result = await run;
  return { ms: performance.now() - t0, result };
}

/** A transaction on its own couli_app connection that runs `hold` and stays open until `release()`. */
function holder(
  database: TestDatabase,
  hold: (trx: Kysely<DB>) => Promise<unknown>,
): { ready: Promise<void>; release: () => void; done: Promise<void> } {
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => undefined;
  const isReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const finished = db
    .transaction()
    .execute(async (trx) => {
      await hold(trx);
      ready();
      await released;
    })
    .catch(() => undefined)
    .finally(() => destroyDb(db).catch(() => undefined));
  return { ready: isReady, release, done: finished.then(() => undefined) };
}

/** Waits (≤ 3 s) until a couli_maint session of this database waits for a lock. */
async function maintWaits(observer: Kysely<DB>): Promise<boolean> {
  for (let i = 0; i < 150; i += 1) {
    const r = await sql<{ n: string }>`
      SELECT count(*)::text AS n
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.usename = 'couli_maint'
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `.execute(observer);
    if (r.rows[0]?.n !== '0') return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function withWorld(
  scenario: (roles: Roles, database: TestDatabase, observer: Kysely<DB>) => Promise<void>,
): Promise<void> {
  const database = await createTestDatabase();
  const roles = connect(database);
  const observer = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  try {
    await scenario(roles, database, observer);
  } finally {
    await destroyDb(observer).catch(() => undefined);
    await disconnect(roles);
    await database.drop();
  }
}

it('[ADR-0001 §4.2 #4; contract I1a Locks] 另一连接的读事务一直持有 link_logs 的锁时：建已有的日子立即返回名字（<2 秒，不申请表锁）；建新的日子 4–9 秒内以 55P03 失败、什么都不建；其间写入 link_logs 的一行在 9 秒内写成', async () => {
  await withWorld(async ({ maint, app }, database, observer) => {
    expect(await ensureDays(maint, 'link_logs', ['2026-10-05'])).toEqual(['link_logs_p20261005']);
    const reader = holder(database, (trx) => sql`SELECT count(*) FROM app.link_logs`.execute(trx));
    try {
      await reader.ready;
      const existing = await timed(ensureDays(maint, 'link_logs', ['2026-10-05']));
      const creating = timed(ensureDays(maint, 'link_logs', ['2026-10-06']));
      const queued = await maintWaits(observer);
      const writing = timed(insertLinkLog(app, '2026-10-05T12:00:00+08:00'));
      const limit = new Promise<{ ms: number; result: string[] }>((resolve) => {
        setTimeout(() => resolve({ ms: 12_000, result: ['still waiting after 12 s'] }), 12_000);
      });
      const created = await Promise.race([creating, limit]);
      const write = await Promise.race([writing, limit.then((l) => ({ ms: l.ms, result: '' }))]);
      reader.release();
      await Promise.all([creating, writing]);
      expect({
        existing: existing.result,
        existingFast: existing.ms < 2_000,
        queued,
        created: created.result,
        createdWithinBound: created.ms >= 4_000 && created.ms <= 9_000,
        write: write.result,
        writeWithinBound: write.ms <= 9_000,
      }).toEqual({
        existing: ['link_logs_p20261005'],
        existingFast: true,
        queued: true,
        created: ['failed 55P03'],
        createdWithinBound: true,
        write: 'app.link_logs_p20261005',
        writeWithinBound: true,
      });
    } finally {
      reader.release();
      await reader.done;
    }
    expect(await partitionNames(maint, 'link_logs')).toEqual([
      'link_logs_default',
      'link_logs_p20261005',
    ]);
  });
}, 60_000);

it('[BR-ID-30 ②; contract I1b Locks] 另一连接的读事务一直持有 link_logs 的锁时：没有过期分区的删除立即返回空数组（<2 秒，不申请表锁）；有过期分区时 4–9 秒内以 55P03 失败，一个都不删（整条语句回滚）', async () => {
  await withWorld(async ({ maint, app }, database, observer) => {
    const days = dayRange('2026-07-08', '2026-07-11');
    expect(await ensureDays(maint, 'link_logs', days)).toEqual(dayNames('link_logs', days));
    expect(await insertLinkLog(app, '2026-07-08T12:00:00+08:00')).toBe('app.link_logs_p20260708');
    const reader = holder(database, (trx) => sql`SELECT count(*) FROM app.link_logs`.execute(trx));
    try {
      await reader.ready;
      // 2026-10-08 12:00 +08:00: cutoff 2026-07-10 00:00 +08:00 — two partitions expired.
      // 2026-10-06 12:00 +08:00: cutoff 2026-07-08 00:00 +08:00 — none expired.
      const nothing = await timed(dropDays(maint, 'link_logs', '2026-10-06T04:00:00Z'));
      const dropping = timed(dropDays(maint, 'link_logs', '2026-10-08T04:00:00Z'));
      const queued = await maintWaits(observer);
      const limit = new Promise<{ ms: number; result: string }>((resolve) => {
        setTimeout(() => resolve({ ms: 12_000, result: 'still waiting after 12 s' }), 12_000);
      });
      const dropped = await Promise.race([dropping, limit]);
      reader.release();
      await dropping;
      expect({
        nothing: nothing.result,
        nothingFast: nothing.ms < 2_000,
        queued,
        dropped: dropped.result,
        droppedWithinBound: dropped.ms >= 4_000 && dropped.ms <= 9_000,
      }).toEqual({
        nothing: [],
        nothingFast: true,
        queued: true,
        dropped: 'failed 55P03',
        droppedWithinBound: true,
      });
    } finally {
      reader.release();
      await reader.done;
    }
    expect(await partitionNames(maint, 'link_logs')).toEqual([
      'link_logs_default',
      ...dayNames('link_logs', days),
    ]);
    expect(await linkLogRows(app)).toEqual([
      { part: 'app.link_logs_p20260708', at: '2026-07-08T04:00:00.000Z' },
    ]);
  });
}, 60_000);

it('[ADR-0001 §4.2 #4; contract I1a Locks（app.users）] 另一连接有一个写 app.users 的事务未结束时：建新的日子要等 app.users 的锁（link_logs 的外键随新分区建立），4–9 秒内以 55P03 失败、什么都不建；建已有的日子与删除仍立即完成', async () => {
  await withWorld(async ({ maint }, database, observer) => {
    expect(await ensureDays(maint, 'link_logs', ['2020-01-01', '2026-10-05'])).toEqual([
      'link_logs_p20200101',
      'link_logs_p20261005',
    ]);
    const writer = holder(database, (trx) =>
      sql`LOCK TABLE app.users IN ROW EXCLUSIVE MODE`.execute(trx),
    );
    try {
      await writer.ready;
      const existing = await timed(ensureDays(maint, 'link_logs', ['2026-10-05']));
      const dropping = await timed(dropDays(maint, 'link_logs', '2025-01-01T00:00:00Z'));
      const creating = timed(ensureDays(maint, 'link_logs', ['2026-10-06']));
      const queued = await maintWaits(observer);
      const limit = new Promise<{ ms: number; result: string[] }>((resolve) => {
        setTimeout(() => resolve({ ms: 12_000, result: ['still waiting after 12 s'] }), 12_000);
      });
      const created = await Promise.race([creating, limit]);
      writer.release();
      await creating;
      expect({
        existing: existing.result,
        existingFast: existing.ms < 2_000,
        dropped: dropping.result,
        droppedFast: dropping.ms < 2_000,
        queued,
        created: created.result,
        createdWithinBound: created.ms >= 4_000 && created.ms <= 9_000,
      }).toEqual({
        existing: ['link_logs_p20261005'],
        existingFast: true,
        dropped: ['link_logs_p20200101'],
        droppedFast: true,
        queued: true,
        created: ['failed 55P03'],
        createdWithinBound: true,
      });
    } finally {
      writer.release();
      await writer.done;
    }
    expect(await partitionNames(maint, 'link_logs')).toEqual([
      'link_logs_default',
      'link_logs_p20261005',
    ]);
  });
}, 60_000);
