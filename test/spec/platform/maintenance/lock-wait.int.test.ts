// Rule tests: every statement of a maintenance run that can wait for a table lock waits at most 5 s
// (B1-01j, code review round 2). Basis: ADR-0001 §4.2 #4 (worker 定时任务以 couli_maint 建和删分区;
// 每张分区表设 DEFAULT 分区兜底), #16 (event_log 与业务写入同一事务写入); 规划/02 §15.1. A lock request
// that waits makes every later writer of that table queue behind it, so an unbounded wait behind one
// open read transaction stalls business writes, and stop() would wait for that run without bound.
//
// Contract supplement (adds to sections C and D of apps/api/src/modules/platform/maintenance/index.ts;
// app.ensure_month_partition of 0003 / 0007 is not redefined):
//   Statements of runOnce and the locks they can wait for —
//     C.1 `SELECT current_user`                      no table lock.
//     C.3 app.ensure_month_partition(table, month)    its advisory lock per partition name and, when
//         the partition is created, CREATE TABLE … PARTITION OF: locks on the parent table and on its
//         DEFAULT partition (which is scanned).
//     C.4 app.drop_expired_month_partitions           bounded by the function itself
//         (lock_timeout=5s, see test/spec/db/partitions/lock-timeout.int.test.ts).
//     C.5 app.partition_default_rows()               ACCESS SHARE on every DEFAULT partition it counts
//         (waits behind an ACCESS EXCLUSIVE holder, e.g. a session creating a partition of that table).
//   Rules —
//     - Each ensure_month_partition call and the partition_default_rows call run in their own short
//       transaction whose first statement is `SELECT set_config('lock_timeout', '5s', true)` (the
//       setting is local to that transaction; the session's own lock_timeout stays as it was).
//     - ensure failing with 55P03 (lock_not_available): one `partition_ensure_failed` line
//       { table, month, sqlstate: '55P03' }, failed += 1, and the remaining months of THAT table are
//       skipped in this run (each further month would wait again); the other tables go on as usual.
//       Other ensure errors keep the per-month behaviour of C.3. The next run tries again.
//     - partition_default_rows failing with 55P03: one `partition_default_check_failed`
//       { sqlstate: '55P03' }, failed += 1 (C.5).
//     - Hence one run waits for locks at most about 5 s × (month-partitioned tables + droppable
//       tables + 1), and stop() waits at most that long for the run in progress.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import type { MaintenanceReport } from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import {
  countingClock,
  createOrStub,
  done,
  line,
  MONTH_ENSURED,
  memoryLogger,
  monthNames,
  monthRange,
  names,
  reduceLine,
} from './kit.ts';

const NOW = '2026-11-20T03:04:05Z'; // 11:04 +08:00; months to keep: 2026-11 … 2027-02

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

async function ensure(maint: Kysely<DB>, table: string, months: readonly string[]): Promise<void> {
  for (const month of months) {
    await sql`SELECT app.ensure_month_partition(${table}, ${`${month}-01`}::date)`.execute(maint);
  }
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

/** A transaction on its own connection that runs `hold` and stays open until `release()`. */
function holder(
  database: TestDatabase,
  role: 'couli_app' | 'couli_maint',
  hold: (trx: Kysely<DB>) => Promise<unknown>,
): { ready: Promise<void>; release: () => void; done: Promise<void> } {
  const db = createDb({ connectionString: database.urlFor(role), max: 1 });
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

/** Settles `run` with its elapsed milliseconds, or reports it as still running after `limitMs`. */
async function within<T>(
  run: Promise<T>,
  limitMs: number,
): Promise<{ ms: number; value: T | string }> {
  const t0 = performance.now();
  const settled = run.then(
    (value) => ({ ms: performance.now() - t0, value }),
    (error: unknown) => ({ ms: performance.now() - t0, value: `rejected ${String(error)}` }),
  );
  const limit = new Promise<{ ms: number; value: string }>((resolve) => {
    setTimeout(
      () => resolve({ ms: limitMs, value: `still running after ${String(limitMs)} ms` }),
      limitMs,
    );
  });
  return Promise.race([settled, limit]);
}

function plain(report: MaintenanceReport | string): unknown {
  return typeof report === 'string' ? report : { ...report };
}

async function insertEvent(app: Kysely<DB>, eventId: string): Promise<void> {
  await sql`
    INSERT INTO app.event_log (app_id, event_id, name, payload, occurred_at)
    VALUES ('couli', ${eventId}::uuid, 'order.created', '{"order_id": "x"}'::jsonb,
            '2026-11-05T00:00:00Z'::timestamptz)
  `.execute(app);
}

/** The months a run at NOW ensures (2026-11 … 2027-02). */
const FOUR_MONTHS = monthRange('2026-11', '2027-02');

/** `all` without the partitions in `skipped`, order kept. */
function except(all: readonly string[], skipped: readonly string[]): string[] {
  return all.filter((name) => !skipped.includes(name));
}

it('[ADR-0001 §4.2 #4; contract C.3 lock_timeout] 读事务持有 event_log 的 ACCESS SHARE 锁、2027-01 分区尚不存在时跑一轮：event_log 预建在 4–12 秒内以 55P03 失败一次（跳过该表其余月份）、orders 照常建满；期间向当月分区的插入 9 秒内写成；读事务结束后下一轮建成', async () => {
  await withWorld(async ({ database, maint, app }) => {
    await ensure(maint, 'event_log', ['2026-11', '2026-12']);
    await ensure(maint, 'orders', ['2026-11', '2026-12']);
    const reader = holder(database, 'couli_app', (trx) =>
      sql`SELECT count(*) FROM app.event_log`.execute(trx),
    );
    await reader.ready;
    const { logger, lines } = memoryLogger();
    const maintenance = createOrStub({ db: maint, logger, clock: countingClock(NOW) });
    const pending: Array<Promise<unknown>> = [];
    try {
      const first = maintenance.runOnce();
      pending.push(first);
      const running = within(first, 20_000);
      const queued = await maintWaits(app);
      const writing = within(insertEvent(app, '00000000-0000-7000-8000-0000000e0001'), 20_000);
      const [run, write] = await Promise.all([running, writing]);
      reader.release();
      await reader.done;
      expect({
        queued,
        runWithinBound: run.ms >= 4_000 && run.ms <= 12_000,
        report: plain(run.value as MaintenanceReport | string),
        writeWithinBound: write.ms <= 9_000,
        lines: lines.map(reduceLine),
      }).toEqual({
        queued: true,
        runWithinBound: true,
        report: {
          ensured: except(monthNames(FOUR_MONTHS), names('event_log', ['2027-01', '2027-02'])),
          dropped: [],
          defaultRows: [],
          failed: 1,
        },
        writeWithinBound: true,
        lines: [
          line('error', 'partition_ensure_failed', {
            table: 'event_log',
            month: '2027-01-01',
            sqlstate: '55P03',
          }),
          done(MONTH_ENSURED - 2, 0, 1),
        ],
      });
      const next = await within(maintenance.runOnce(), 20_000);
      expect(plain(next.value as MaintenanceReport | string)).toEqual({
        ensured: monthNames(FOUR_MONTHS),
        dropped: [],
        defaultRows: [],
        failed: 0,
      });
      expect(await partitionNames(app, 'event_log')).toEqual([
        'event_log_default',
        ...names('event_log', monthRange('2026-11', '2027-02')),
      ]);
    } finally {
      reader.release();
      await reader.done;
      await Promise.all(pending.map((p) => p.catch(() => undefined)));
      await maintenance.stop().catch(() => undefined);
    }
  });
}, 90_000);

it('[ADR-0001 §4.2 #4; contract C.3 lock_timeout] 读事务同时持有 event_log 与 orders 的锁：两张表各失败一次（各 55P03 一条），一轮在 8–18 秒内结束；读事务结束后下一轮两张表都建成', async () => {
  await withWorld(async ({ database, maint, app }) => {
    await ensure(maint, 'event_log', ['2026-11', '2026-12']);
    await ensure(maint, 'orders', ['2026-11', '2026-12']);
    const reader = holder(database, 'couli_app', async (trx) => {
      await sql`SELECT count(*) FROM app.event_log`.execute(trx);
      await sql`SELECT count(*) FROM app.orders`.execute(trx);
    });
    await reader.ready;
    const { logger, lines } = memoryLogger();
    const maintenance = createOrStub({ db: maint, logger, clock: countingClock(NOW) });
    const pending: Array<Promise<unknown>> = [];
    try {
      const first = maintenance.runOnce();
      pending.push(first);
      const run = await within(first, 30_000);
      reader.release();
      await reader.done;
      expect({
        runWithinBound: run.ms >= 8_000 && run.ms <= 18_000,
        report: plain(run.value as MaintenanceReport | string),
        lines: lines.map(reduceLine),
      }).toEqual({
        runWithinBound: true,
        report: {
          ensured: except(monthNames(FOUR_MONTHS), [
            ...names('event_log', ['2027-01', '2027-02']),
            ...names('orders', ['2027-01', '2027-02']),
          ]),
          dropped: [],
          defaultRows: [],
          failed: 2,
        },
        lines: [
          line('error', 'partition_ensure_failed', {
            table: 'event_log',
            month: '2027-01-01',
            sqlstate: '55P03',
          }),
          line('error', 'partition_ensure_failed', {
            table: 'orders',
            month: '2027-01-01',
            sqlstate: '55P03',
          }),
          done(MONTH_ENSURED - 4, 0, 2),
        ],
      });
      const next = await within(maintenance.runOnce(), 20_000);
      expect((plain(next.value as MaintenanceReport | string) as { failed?: unknown }).failed).toBe(
        0,
      );
      expect(await partitionNames(app, 'orders')).toEqual([
        'orders_default',
        ...names('orders', monthRange('2026-11', '2027-02')),
      ]);
    } finally {
      reader.release();
      await reader.done;
      await Promise.all(pending.map((p) => p.catch(() => undefined)));
      await maintenance.stop().catch(() => undefined);
    }
  });
}, 90_000);

it('[ADR-0001 §4.2 #4 DEFAULT 有数据即告警; contract C.5 lock_timeout] 另一会话正在建 event_log_p202701（事务未提交，持有父表与 DEFAULT 分区的排他锁）时跑一轮：该月预建与 DEFAULT 计数各在 5 秒左右以 55P03 失败一次，一轮在 8–18 秒内结束，orders 照常；之后下一轮正常', async () => {
  await withWorld(async ({ database, maint, app }) => {
    await ensure(maint, 'event_log', ['2026-11', '2026-12']);
    await ensure(maint, 'orders', monthRange('2026-11', '2027-02'));
    const creator = holder(database, 'couli_maint', (trx) =>
      sql`SELECT app.ensure_month_partition('event_log', '2027-01-01'::date)`.execute(trx),
    );
    await creator.ready;
    const { logger, lines } = memoryLogger();
    const maintenance = createOrStub({ db: maint, logger, clock: countingClock(NOW) });
    const pending: Array<Promise<unknown>> = [];
    try {
      const first = maintenance.runOnce();
      pending.push(first);
      const run = await within(first, 30_000);
      creator.release();
      await creator.done;
      expect({
        runWithinBound: run.ms >= 8_000 && run.ms <= 18_000,
        report: plain(run.value as MaintenanceReport | string),
        lines: lines.map(reduceLine),
      }).toEqual({
        runWithinBound: true,
        report: {
          ensured: except(monthNames(FOUR_MONTHS), names('event_log', ['2027-01', '2027-02'])),
          dropped: [],
          defaultRows: [],
          failed: 2,
        },
        lines: [
          line('error', 'partition_ensure_failed', {
            table: 'event_log',
            month: '2027-01-01',
            sqlstate: '55P03',
          }),
          line('error', 'partition_default_check_failed', { sqlstate: '55P03' }),
          done(MONTH_ENSURED - 2, 0, 2),
        ],
      });
      const next = await within(maintenance.runOnce(), 20_000);
      expect(plain(next.value as MaintenanceReport | string)).toEqual({
        ensured: monthNames(FOUR_MONTHS),
        dropped: [],
        defaultRows: [],
        failed: 0,
      });
      expect(await partitionNames(app, 'event_log')).toEqual([
        'event_log_default',
        ...names('event_log', monthRange('2026-11', '2027-02')),
      ]);
    } finally {
      creator.release();
      await creator.done;
      await Promise.all(pending.map((p) => p.catch(() => undefined)));
      await maintenance.stop().catch(() => undefined);
    }
  });
}, 90_000);
