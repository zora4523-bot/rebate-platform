// Rule tests of the maintenance schedule against a real PostgreSQL (B1-01j; contract section D in
// apps/api/src/modules/platform/maintenance/index.ts). Basis: ADR-0001 §4.2 #4 (worker 里的定时任务以
// couli_maint 建和删分区); 规划/02 §15.1 (分区的预建与删除由 worker 定时任务以专用角色执行). The queue
// contract has no cron schedules (platform/queue §5.3), so the module schedules itself (待编排会话确认).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import {
  countingClock,
  createOrStub,
  gate,
  settableClock,
  track,
  done,
  line,
  memoryLogger,
  reduceLine,
  rejectionProblems,
  sleep,
  waitFor,
} from './kit.ts';

async function withDatabase(scenario: (database: TestDatabase) => Promise<void>): Promise<void> {
  const database = await createTestDatabase();
  try {
    await scenario(database);
  } finally {
    await database.drop();
  }
}

async function eventLogPartitions(db: Kysely<DB>): Promise<string[]> {
  const rows = await sql<{ name: string }>`
    SELECT c.relname::text AS name
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'app' AND p.relname = 'event_log'
    ORDER BY c.relname COLLATE "C"
  `.execute(db);
  return rows.rows.map((r) => r.name);
}

it('[ADR-0001 §4.2 #4 worker 定时任务; contract D] start() 先跑完第一轮再 resolve，之后每 intervalMs 再跑；stop() 等进行中的一轮、之后不再跑；再 start() 拒绝 already_started', async () => {
  await withDatabase(async (database) => {
    const maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 2 });
    const app = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
    const { logger, lines } = memoryLogger();
    const clock = countingClock('2026-11-20T03:04:05Z');
    const maintenance = createOrStub({ db: maint, logger, clock, intervalMs: 200 });
    const doneCount = (): number =>
      lines
        .map(reduceLine)
        .filter((l) => typeof l === 'object' && l.msg === 'partition_maintenance_done').length;
    try {
      const started = await maintenance.start().then(
        () => 'resolved',
        (error: unknown) => `rejected ${String(error)}`,
      );
      const afterStart = {
        started,
        lines: lines.map(reduceLine),
        partitions: await eventLogPartitions(app),
      };
      expect(afterStart).toEqual({
        started: 'resolved',
        lines: [done(8, 0, 0)],
        partitions: [
          'event_log_default',
          'event_log_p202611',
          'event_log_p202612',
          'event_log_p202701',
          'event_log_p202702',
        ],
      });
      expect(await waitFor(() => doneCount() >= 4, 10_000)).toBe(true);
      await maintenance.stop();
      const atStop = lines.length;
      const callsAtStop = clock.calls();
      await sleep(700);
      expect({ lines: lines.length, calls: clock.calls() }).toEqual({
        lines: atStop,
        calls: callsAtStop,
      });
      expect(lines.map(reduceLine)).toEqual(Array(atStop).fill(done(8, 0, 0)));
      expect(await maintenance.stop()).toBeUndefined();
      expect(await rejectionProblems(maintenance.start(), 'already_started')).toEqual([]);
    } finally {
      await maintenance.stop().catch(() => undefined);
      await Promise.all([maint, app].map((db) => destroyDb(db)));
    }
  });
});

it('[ADR-0001 §4.2 #8 以 couli_maint 执行; contract D] 以 couli_app 连接 start()：拒绝 wrong_role、不安排后续运行（三个间隔内不再读时钟、不写日志、不建分区）', async () => {
  await withDatabase(async (database) => {
    const app = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
    const { logger, lines } = memoryLogger();
    const clock = countingClock('2026-11-20T03:04:05Z');
    const maintenance = createOrStub({ db: app, logger, clock, intervalMs: 100 });
    try {
      expect(await rejectionProblems(maintenance.start(), 'wrong_role')).toEqual([]);
      await sleep(400);
      expect({
        lines: lines.length,
        clock: clock.calls(),
        partitions: await eventLogPartitions(app),
      }).toEqual({ lines: 0, clock: 0, partitions: ['event_log_default'] });
    } finally {
      await maintenance.stop().catch(() => undefined);
      await destroyDb(app);
    }
  });
});

it('[contract D、E] 连不上数据库时：start() 记 partition_maintenance_failed（sqlstate 为 null，不带连接串或错误文本）后照常 resolve，之后每轮失败各记一条；stop() 正常结束', async () => {
  // Port 1 on the loopback interface: nothing listens there, so every connection is refused.
  const unreachable = createDb({
    connectionString: 'postgres://couli_maint@127.0.0.1:1/couli_nowhere',
    max: 1,
  });
  const { logger, lines } = memoryLogger();
  const maintenance = createOrStub({
    db: unreachable,
    logger,
    clock: countingClock('2026-11-20T03:04:05Z'),
    intervalMs: 100,
  });
  try {
    const started = await maintenance.start().then(
      () => 'resolved',
      (error: unknown) => `rejected ${String(error)}`,
    );
    expect({ started, lines: lines.map(reduceLine) }).toEqual({
      started: 'resolved',
      lines: [line('error', 'partition_maintenance_failed', { sqlstate: null })],
    });
    expect(await waitFor(() => lines.length >= 3, 10_000)).toBe(true);
    await maintenance.stop();
    expect(new Set(lines.map((l) => JSON.stringify(reduceLine(l))))).toEqual(
      new Set([JSON.stringify(line('error', 'partition_maintenance_failed', { sqlstate: null }))]),
    );
    expect(lines.join('')).not.toMatch(/couli_nowhere|ECONNREFUSED|127\.0\.0\.1/);
  } finally {
    await maintenance.stop().catch(() => undefined);
    await destroyDb(unreachable).catch(() => undefined);
  }
});

async function eventLogNames(db: Kysely<DB>): Promise<string[]> {
  return eventLogPartitions(db);
}

it('[BR-ID-30 每日 04:00（+08:00）删除任务; contract C.4、D] 定时运行：时钟停在 2026-10-09 03:59:59.999（+08:00）时各轮只预建、不删；拨到 04:00:00.000 后的下一轮删 p202602、p202603，之后各轮不再删', async () => {
  await withDatabase(async (database) => {
    const maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 2 });
    const app = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
    for (const month of ['2026-02', '2026-03', '2026-04', '2026-05']) {
      await sql`SELECT app.ensure_month_partition('event_log', ${`${month}-01`}::date)`.execute(
        maint,
      );
    }
    const { logger, lines } = memoryLogger();
    const clock = settableClock('2026-10-08T19:59:59.999Z');
    const maintenance = createOrStub({ db: maint, logger, clock, intervalMs: 150 });
    const reduced = (): unknown[] => lines.map(reduceLine);
    try {
      const started = await maintenance.start().then(
        () => 'resolved',
        (error: unknown) => `rejected ${String(error)}`,
      );
      expect(started).toBe('resolved');
      expect(await waitFor(() => lines.length >= 3, 10_000)).toBe(true);
      expect(reduced().slice(0, 3)).toEqual([done(8, 0, 0), done(8, 0, 0), done(8, 0, 0)]);
      expect(await eventLogNames(app)).toContain('event_log_p202602');
      clock.set('2026-10-08T20:00:00.000Z');
      expect(
        await waitFor(
          () =>
            reduced().filter((l) => (l as { msg?: unknown }).msg === 'partition_dropped').length >=
            2,
          10_000,
        ),
      ).toBe(true);
      const atSwitch = lines.length;
      expect(await waitFor(() => lines.length >= atSwitch + 2, 10_000)).toBe(true);
      await maintenance.stop();
      const all = reduced();
      const firstDrop = all.findIndex((l) => (l as { msg?: unknown }).msg === 'partition_dropped');
      expect(
        all.slice(0, firstDrop).every((l) => JSON.stringify(l) === JSON.stringify(done(8, 0, 0))),
      ).toBe(true);
      expect(all.slice(firstDrop)).toEqual([
        line('info', 'partition_dropped', { table: 'event_log', partition: 'event_log_p202602' }),
        line('info', 'partition_dropped', { table: 'event_log', partition: 'event_log_p202603' }),
        done(8, 2, 0),
        ...Array(all.length - firstDrop - 3).fill(done(8, 0, 0)),
      ]);
      expect(await eventLogNames(app)).toEqual([
        'event_log_default',
        ...['202604', '202605', '202610', '202611', '202612', '202701'].map(
          (m) => `event_log_p${m}`,
        ),
      ]);
    } finally {
      await maintenance.stop().catch(() => undefined);
      await Promise.all([maint, app].map((db) => destroyDb(db)));
    }
  });
});

it('[contract D stop 等进行中的一轮] 第一轮卡在 event_log_p202611 的分区锁上（另一连接持有 ensure_month_partition 用的咨询锁）时调用 stop()：锁未放开前 start() 与 stop() 都不结束、没有日志；放锁后这一轮完成（一条 done），start() resolve，stop() 在 done 之后才结束，之后不再运行', async () => {
  await withDatabase(async (database) => {
    const maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 2 });
    const holder = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
    const observer = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
    const { logger, lines } = memoryLogger();
    const maintenance = createOrStub({
      db: maint,
      logger,
      clock: countingClock('2026-11-20T03:04:05Z'),
      intervalMs: 100,
    });
    const barrier = gate();
    const locked = gate();
    const key = 'app.ensure_month_partition:event_log_p202611';
    const holding = holder.connection().execute(async (conn) => {
      await sql`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`.execute(conn);
      locked.open();
      await barrier.wait();
      await sql`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`.execute(conn);
    });
    try {
      await locked.wait();
      const startState = track(maintenance.start());
      const waiting = await waitFor(async () => {
        const r = await sql<{ n: string }>`
          SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
        `.execute(observer);
        return r.rows[0]?.n === '1';
      }, 10_000);
      let linesWhenStopped = -1;
      const stopping = maintenance.stop().then(() => {
        linesWhenStopped = lines.length;
      });
      const stopState = track(stopping);
      await sleep(400);
      const blocked = { waiting, start: startState(), stop: stopState(), lines: lines.length };
      barrier.open();
      await holding;
      await stopping.catch(() => undefined);
      await sleep(400);
      expect({
        blocked,
        start: startState(),
        linesWhenStopped,
        lines: lines.map(reduceLine),
      }).toEqual({
        blocked: { waiting: true, start: 'pending', stop: 'pending', lines: 0 },
        start: 'resolved',
        linesWhenStopped: 1,
        lines: [done(8, 0, 0)],
      });
    } finally {
      barrier.open();
      await holding.catch(() => undefined);
      await maintenance.stop().catch(() => undefined);
      await Promise.all([maint, holder, observer].map((db) => destroyDb(db)));
    }
  });
});
