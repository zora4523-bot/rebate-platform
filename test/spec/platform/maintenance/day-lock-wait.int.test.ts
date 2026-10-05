// Rule tests: lock waits of the day-partition steps of a maintenance run are bounded and logged
// (B1-01s; contract section I2 with the lock-wait addendum of B1-01j in
// test/spec/platform/maintenance/lock-wait.int.test.ts). Basis: ADR-0001 §4.2 #4 (worker 定时任务以
// couli_maint 建和删分区); BR-ID-30 ② (link_logs 按日分区删除). A run whose first day waits 5 s and fails
// with 55P03 skips the remaining days of that table (else 15 × 5 s); a failed deletion is logged and
// retried on the next run.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import type { MaintenanceReport } from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import { dayNames, dayRange, ensureDays } from '../../db/partitions/day-kit.ts';
import {
  countingClock,
  createOrStub,
  done,
  line,
  memoryLogger,
  monthRange,
  names,
  reduceLine,
} from './kit.ts';

interface World {
  readonly database: TestDatabase;
  readonly maint: Kysely<DB>;
  readonly app: Kysely<DB>;
}

async function withWorld(scenario: (world: World) => Promise<void>): Promise<void> {
  const database = await createTestDatabase();
  const maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 2 });
  const app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  try {
    await scenario({ database, maint, app });
  } finally {
    await Promise.all([maint, app].map((db) => destroyDb(db).catch(() => undefined)));
    await database.drop();
  }
}

/** A read transaction on link_logs on its own connection, open until `release()`. */
function reader(database: TestDatabase): {
  ready: Promise<void>;
  release: () => void;
  done: Promise<void>;
} {
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
      await sql`SELECT count(*) FROM app.link_logs`.execute(trx);
      ready();
      await released;
    })
    .catch(() => undefined)
    .finally(() => destroyDb(db).catch(() => undefined));
  return { ready: isReady, release, done: finished.then(() => undefined) };
}

async function partitionNames(app: Kysely<DB>, table: string): Promise<string[]> {
  const rows = await sql<{ name: string }>`
    SELECT c.relname::text AS name
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'app' AND p.relname = ${table}
    ORDER BY c.relname COLLATE "C"
  `.execute(app);
  return rows.rows.map((r) => r.name);
}

async function timedReport(
  run: Promise<MaintenanceReport>,
): Promise<{ ms: number; report: unknown }> {
  const t0 = performance.now();
  let report: unknown;
  try {
    report = { ...(await run) };
  } catch (error) {
    report = { error: String(error) };
  }
  return { ms: performance.now() - t0, report };
}

const NOW = '2026-11-20T03:04:05Z'; // 11:04 +08:00; days 2026-11-20 … 2026-12-04
const MONTHS = monthRange('2026-11', '2027-02');
const MONTH_NAMES = [...names('event_log', MONTHS), ...names('orders', MONTHS)];

it('[ADR-0001 §4.2 #4; contract I2 C.3b 55P03] 读事务一直持有 link_logs 的锁时：第一个日分区等 5 秒以 55P03 失败，记一条 partition_ensure_failed（day 2026-11-20），其余 14 天本轮跳过；整轮在 4–15 秒内结束，月分区照建；锁放开后下一轮建齐 15 天', async () => {
  await withWorld(async ({ database, maint, app }) => {
    const hold = reader(database);
    let first: { ms: number; report: unknown } = { ms: 0, report: 'not run' };
    let firstLines: unknown[] = [];
    try {
      await hold.ready;
      const { logger, lines } = memoryLogger();
      const maintenance = createOrStub({
        db: maint,
        logger,
        clock: countingClock(NOW),
        dayPartitions: true,
      });
      first = await timedReport(maintenance.runOnce());
      firstLines = lines.map(reduceLine);
    } finally {
      hold.release();
      await hold.done;
    }
    expect({ report: first.report, withinBound: first.ms >= 4_000 && first.ms <= 15_000 }).toEqual({
      report: { ensured: MONTH_NAMES, dropped: [], defaultRows: [], failed: 1 },
      withinBound: true,
    });
    expect(firstLines).toEqual([
      line('error', 'partition_ensure_failed', {
        table: 'link_logs',
        day: '2026-11-20',
        sqlstate: '55P03',
      }),
      done(8, 0, 1),
    ]);
    expect(await partitionNames(app, 'link_logs')).toEqual(['link_logs_default']);

    const { logger, lines } = memoryLogger();
    const next = createOrStub({
      db: maint,
      logger,
      clock: countingClock(NOW),
      dayPartitions: true,
    });
    const days = dayRange('2026-11-20', '2026-12-04');
    expect((await timedReport(next.runOnce())).report).toEqual({
      ensured: [...MONTH_NAMES, ...dayNames('link_logs', days)],
      dropped: [],
      defaultRows: [],
      failed: 0,
    });
    expect(lines.map(reduceLine)).toEqual([done(23, 0, 0)]);
  });
}, 60_000);

it('[BR-ID-30 ②; contract I2 C.4 55P03] 04:00（+08:00）的运行在读事务持有 link_logs 的锁时：已有的 15 个日分区立即照样列出；删 link_logs 的过期分区 5 秒后以 55P03 失败，记一条 partition_drop_failed，DEFAULT 检查照做；什么都没删，下一轮（锁放开后）删掉', async () => {
  await withWorld(async ({ database, maint, app }) => {
    const ahead = dayRange('2026-10-09', '2026-10-23');
    const old = dayRange('2026-07-09', '2026-07-10');
    expect(await ensureDays(maint, 'link_logs', [...old, ...ahead])).toEqual(
      dayNames('link_logs', [...old, ...ahead]),
    );
    const months = monthRange('2026-10', '2027-01');
    const ensured = [
      ...names('event_log', months),
      ...names('orders', months),
      ...dayNames('link_logs', ahead),
    ];
    const at = '2026-10-08T20:00:00.000Z'; // 2026-10-09 04:00 +08:00, cutoff 2026-07-11 00:00
    const hold = reader(database);
    let first: { ms: number; report: unknown } = { ms: 0, report: 'not run' };
    let firstLines: unknown[] = [];
    try {
      await hold.ready;
      const { logger, lines } = memoryLogger();
      const maintenance = createOrStub({
        db: maint,
        logger,
        clock: countingClock(at),
        dayPartitions: true,
      });
      first = await timedReport(maintenance.runOnce());
      firstLines = lines.map(reduceLine);
    } finally {
      hold.release();
      await hold.done;
    }
    expect({ report: first.report, withinBound: first.ms >= 4_000 && first.ms <= 12_000 }).toEqual({
      report: { ensured, dropped: [], defaultRows: [], failed: 1 },
      withinBound: true,
    });
    expect(firstLines).toEqual([
      line('error', 'partition_drop_failed', { table: 'link_logs', sqlstate: '55P03' }),
      done(23, 0, 1),
    ]);
    expect(await partitionNames(app, 'link_logs')).toEqual([
      'link_logs_default',
      ...dayNames('link_logs', [...old, ...ahead]),
    ]);

    const { logger, lines } = memoryLogger();
    const next = createOrStub({ db: maint, logger, clock: countingClock(at), dayPartitions: true });
    expect((await timedReport(next.runOnce())).report).toEqual({
      ensured,
      dropped: dayNames('link_logs', old),
      defaultRows: [],
      failed: 0,
    });
    expect(lines.map(reduceLine)).toEqual([
      ...dayNames('link_logs', old).map((partition) =>
        line('info', 'partition_dropped', { table: 'link_logs', partition }),
      ),
      done(23, 2, 0),
    ]);
  });
}, 60_000);
