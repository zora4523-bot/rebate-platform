// B1-01zw — 规则测试补漏（来源 followups/INDEX.md F-19；followups/B1-01g-queue-test-gaps.md B1-01j 节）。
// 复刻 test/spec/platform/maintenance/lock-wait.int.test.ts 第 169–204 行的场景：读事务持有 event_log 的
// ACCESS SHARE 锁、2027-01 分区尚不存在时跑一轮维护；维护会话等锁期间，另一连接向当月分区插入一行。
// 原用例的 within 把被拒绝的写入也算作「按时完成」，只断言了耗时；本文件另断言该插入成功提交
// （不是 rejected，提交后从另一次查询能查到该行、且落在当月分区），耗时上界保留，维护本轮结果照原用例。
// 依据：ADR-0001 §4.2 #4（预建分区、DEFAULT 兜底）、#16（event_log 与业务写入同一事务写入）；
// apps/api/src/modules/platform/maintenance/index.ts 契约 C.3 与 lock-wait.int.test.ts 文件头的
// lock_timeout 补充（每次 ensure 在自己的短事务里设 lock_timeout=5s，55P03 时跳过该表其余月份）。
// 只新增文件，对现有实现应为绿（补漏检，不走先红）。等待一律轮询终态并带显式超时，不以固定休眠判结果。
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
  track,
  waitFor,
} from './kit.ts';

const NOW = '2026-11-20T03:04:05Z'; // 11:04 +08:00; months to keep: 2026-11 … 2027-02
const EVENT_ID = '00000000-0000-7000-8000-0000000e0b01';

/** The months a run at NOW ensures (2026-11 … 2027-02). */
const FOUR_MONTHS = monthRange('2026-11', '2027-02');

/** Generous upper bounds so the test does not misfire under load. */
const RUN_LIMIT_MS = 20_000;
const WRITE_LIMIT_MS = 20_000;
const MAINT_WAIT_LIMIT_MS = 5_000;

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

/** Polls (≤ limitMs) until a couli_maint session of this database waits for a lock. */
async function maintWaits(observer: Kysely<DB>, limitMs: number): Promise<boolean> {
  return waitFor(async () => {
    const r = await sql<{ n: string }>`
      SELECT count(*)::text AS n
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.usename = 'couli_maint'
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `.execute(observer);
    return r.rows[0]?.n !== '0';
  }, limitMs);
}

/**
 * Starts timing `run`: `state()` is `pending`, `resolved` or `rejected <error>`; `ms()` is the time
 * from now until it settled (undefined while pending); `value()` is the resolved value, if any.
 */
function timed<T>(run: Promise<T>): {
  state: () => string;
  ms: () => number | undefined;
  value: () => T | undefined;
} {
  const t0 = performance.now();
  let ms: number | undefined;
  let value: T | undefined;
  const state = track(
    run.then(
      (v) => {
        ms = performance.now() - t0;
        value = v;
        return v;
      },
      (error: unknown) => {
        ms = performance.now() - t0;
        throw error;
      },
    ),
  );
  return { state, ms: () => ms, value: () => value };
}

/** Polls (≤ limitMs) until `run` has settled; returns its final state. */
async function settled(run: { state: () => string }, limitMs: number): Promise<string> {
  await waitFor(() => run.state() !== 'pending', limitMs);
  const final = run.state();
  return final === 'pending' ? `still running after ${String(limitMs)} ms` : final;
}

function plain(report: MaintenanceReport | undefined): unknown {
  return report === undefined ? report : { ...report };
}

async function insertEvent(app: Kysely<DB>, eventId: string): Promise<void> {
  await sql`
    INSERT INTO app.event_log (app_id, event_id, name, payload, occurred_at)
    VALUES ('couli', ${eventId}::uuid, 'order.created', '{"order_id": "x"}'::jsonb,
            '2026-11-05T00:00:00Z'::timestamptz)
  `.execute(app);
}

/** The partitions holding the committed rows with `eventId`, as seen by a new statement. */
async function committedIn(app: Kysely<DB>, eventId: string): Promise<string[]> {
  const rows = await sql<{ name: string }>`
    SELECT c.relname::text AS name
    FROM app.event_log e
    JOIN pg_class c ON c.oid = e.tableoid
    WHERE e.event_id = ${eventId}::uuid
  `.execute(app);
  return rows.rows.map((r) => r.name);
}

/** `all` without the partitions in `skipped`, order kept. */
function except(all: readonly string[], skipped: readonly string[]): string[] {
  return all.filter((name) => !skipped.includes(name));
}

it('[AC-B1-01zw#1] [ADR-0001 §4.2 #4 #16; contract C.3 lock_timeout] 读事务持有 event_log 的 ACCESS SHARE 锁、2027-01 分区尚不存在时跑一轮：维护等锁期间向当月分区的并发插入成功提交（不被拒绝、9 秒内完成、之后可在 event_log_p202611 查到该行），本轮 event_log 预建以 55P03 失败一次、orders 照常建满；读事务结束后下一轮建成', async () => {
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
      const run = timed(first);
      const queued = await maintWaits(app, MAINT_WAIT_LIMIT_MS);
      const writing = insertEvent(app, EVENT_ID);
      pending.push(writing);
      const write = timed(writing);
      const [runState, writeState] = await Promise.all([
        settled(run, RUN_LIMIT_MS),
        settled(write, WRITE_LIMIT_MS),
      ]);
      reader.release();
      await reader.done;
      const writeMs = write.ms();
      expect({
        queued,
        writeState,
        writeWithinBound: writeMs !== undefined && writeMs <= 9_000,
        committedIn: await committedIn(app, EVENT_ID),
        runState,
        report: plain(run.value()),
        lines: lines.map(reduceLine),
      }).toEqual({
        queued: true,
        writeState: 'resolved',
        writeWithinBound: true,
        committedIn: names('event_log', ['2026-11']),
        runState: 'resolved',
        report: {
          ensured: except(monthNames(FOUR_MONTHS), names('event_log', ['2027-01', '2027-02'])),
          dropped: [],
          defaultRows: [],
          failed: 1,
        },
        lines: [
          line('error', 'partition_ensure_failed', {
            table: 'event_log',
            month: '2027-01-01',
            sqlstate: '55P03',
          }),
          done(MONTH_ENSURED - 2, 0, 1),
        ],
      });
      const second = maintenance.runOnce();
      pending.push(second);
      const next = timed(second);
      expect({
        state: await settled(next, RUN_LIMIT_MS),
        report: plain(next.value()),
      }).toEqual({
        state: 'resolved',
        report: {
          ensured: monthNames(FOUR_MONTHS),
          dropped: [],
          defaultRows: [],
          failed: 0,
        },
      });
      expect(await partitionNames(app, 'event_log')).toEqual([
        'event_log_default',
        ...names('event_log', monthRange('2026-11', '2027-02')),
      ]);
      expect(await committedIn(app, EVENT_ID)).toEqual(names('event_log', ['2026-11']));
    } finally {
      reader.release();
      await reader.done;
      await Promise.all(pending.map((p) => p.catch(() => undefined)));
      await maintenance.stop().catch(() => undefined);
    }
  });
}, 90_000);
