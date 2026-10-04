// Rule tests of one maintenance run against a real PostgreSQL (B1-01j; contract sections C and E in
// apps/api/src/modules/platform/maintenance/index.ts). Basis: ADR-0001 §4.2 #4 (worker 定时任务以
// couli_maint 建和删分区; 按月的表预建未来 3 个月; DEFAULT 分区有数据即告警), #5 (orders、event_log 按月),
// #10 (时钟), #16 (event_log 留存 ≥190 天); 规划/02 §15.1; BR-ID-30 ⑯、⑰. Every test clones its own
// database; the module connects as couli_maint, the observer as couli_app.
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
  memoryLogger,
  monthRange,
  names,
  reduceLine,
  rejectionProblems,
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

/** A maintenance instance on `db` at the fixed instant `now`, with its memory log. */
function instanceAt(db: Kysely<DB>, now: string) {
  const { logger, lines } = memoryLogger();
  const clock = countingClock(now);
  const maintenance = createOrStub({ db, logger, clock });
  return { maintenance, lines, clock, reduced: () => lines.map(reduceLine) };
}

/** Children of app.<table>, ordered by name, with bounds rendered in UTC. */
async function partitionsOf(
  app: Kysely<DB>,
  table: string,
): Promise<Array<{ name: string; bound: string }>> {
  return app.transaction().execute(async (trx) => {
    await sql`SET LOCAL TIME ZONE 'UTC'`.execute(trx);
    const rows = await sql<{ name: string; bound: string }>`
      SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
      FROM pg_inherits i
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = 'app' AND p.relname = ${table}
      ORDER BY c.relname COLLATE "C"
    `.execute(trx);
    return rows.rows.map((row) => ({ name: row.name, bound: row.bound }));
  });
}

async function partitionNames(app: Kysely<DB>, table: string): Promise<string[]> {
  return (await partitionsOf(app, table)).map((p) => p.name);
}

function bound(month: string): string {
  const next = monthRange(month, '9999-12')[1] ?? '';
  return `FOR VALUES FROM ('${month}-01 00:00:00+00') TO ('${next}-01 00:00:00+00')`;
}

/** Month partitions of `months` as couli_maint, outside the module (test setup). */
async function ensure(maint: Kysely<DB>, table: string, months: readonly string[]): Promise<void> {
  for (const month of months) {
    await sql`SELECT app.ensure_month_partition(${table}, ${`${month}-01`}::date)`.execute(maint);
  }
}

let seq = 0;
async function insertEvent(app: Kysely<DB>, occurredAt: string, payload: object): Promise<string> {
  seq += 1;
  const id = `00000000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
  const result = await sql<{ part: string }>`
    INSERT INTO app.event_log (app_id, event_id, name, payload, occurred_at)
    VALUES ('couli', ${id}::uuid, 'user.updated', ${JSON.stringify(payload)}::jsonb,
            ${occurredAt}::timestamptz)
    RETURNING tableoid::regclass::text AS part
  `.execute(app);
  return result.rows[0]?.part ?? '';
}

async function report(run: Promise<MaintenanceReport>): Promise<unknown> {
  try {
    const value = await run;
    return { ...value };
  } catch (error) {
    return { error: String(error) };
  }
}

it('[ADR-0001 §4.2 #4 按月的表预建未来 3 个月、#5; contract C] 新库上一次运行（时钟 2026-11-20）：event_log 与 orders 各建 2026-11 至 2027-02 四个 UTC 月分区（界确切），报告与日志确切，时钟只读一次', async () => {
  await withWorld(async ({ maint, app }) => {
    const { maintenance, clock, reduced } = instanceAt(maint, '2026-11-20T03:04:05Z');
    const months = monthRange('2026-11', '2027-02');
    expect(await report(maintenance.runOnce())).toEqual({
      ensured: [...names('event_log', months), ...names('orders', months)],
      dropped: [],
      defaultRows: [],
      failed: 0,
    });
    expect(clock.calls()).toBe(1);
    expect(await partitionsOf(app, 'event_log')).toEqual([
      { name: 'event_log_default', bound: 'DEFAULT' },
      ...months.map((m) => ({ name: names('event_log', [m])[0], bound: bound(m) })),
    ]);
    expect(await partitionsOf(app, 'orders')).toEqual([
      { name: 'orders_default', bound: 'DEFAULT' },
      ...months.map((m) => ({ name: names('orders', [m])[0], bound: bound(m) })),
    ]);
    expect(await partitionNames(app, 'link_logs')).toEqual(['link_logs_default']);
    expect(reduced()).toEqual([done(8, 0, 0)]);
  });
});

it('[ADR-0001 §4.2 #4 幂等] 同一时钟再跑两次：报告相同（已存在的分区照样列出）、分区不多不少、每次只有一条 done 日志', async () => {
  await withWorld(async ({ maint, app }) => {
    const { maintenance, reduced } = instanceAt(maint, '2026-11-20T03:04:05Z');
    const months = monthRange('2026-11', '2027-02');
    const expected = {
      ensured: [...names('event_log', months), ...names('orders', months)],
      dropped: [],
      defaultRows: [],
      failed: 0,
    };
    expect(await report(maintenance.runOnce())).toEqual(expected);
    expect(await report(maintenance.runOnce())).toEqual(expected);
    expect(await report(maintenance.runOnce())).toEqual(expected);
    expect(await partitionNames(app, 'event_log')).toEqual([
      'event_log_default',
      ...names('event_log', months),
    ]);
    expect(reduced()).toEqual([done(8, 0, 0), done(8, 0, 0), done(8, 0, 0)]);
  });
});

it('[ADR-0001 §4.2 #10 时钟; contract C.2、C.3] 月份只按注入的时钟、按 UTC 月：北京时间已到 12 月（2026-11-30T16:30Z）仍从 2026-11 起；2026-12-31T23:59:59.999Z 建到 2027-03；跨到 2027-01-01T00:00Z 只新增 2027-04', async () => {
  await withWorld(async ({ maint, app }) => {
    const first = instanceAt(maint, '2026-11-30T16:30:00Z');
    const nov = monthRange('2026-11', '2027-02');
    expect(await report(first.maintenance.runOnce())).toEqual({
      ensured: [...names('event_log', nov), ...names('orders', nov)],
      dropped: [],
      defaultRows: [],
      failed: 0,
    });
    const second = instanceAt(maint, '2026-12-31T23:59:59.999Z');
    const dec = monthRange('2026-12', '2027-03');
    expect(((await report(second.maintenance.runOnce())) as MaintenanceReport).ensured).toEqual([
      ...names('event_log', dec),
      ...names('orders', dec),
    ]);
    const third = instanceAt(maint, '2027-01-01T00:00:00Z');
    const jan = monthRange('2027-01', '2027-04');
    expect(((await report(third.maintenance.runOnce())) as MaintenanceReport).ensured).toEqual([
      ...names('event_log', jan),
      ...names('orders', jan),
    ]);
    expect(await partitionNames(app, 'event_log')).toEqual([
      'event_log_default',
      ...names('event_log', monthRange('2026-11', '2027-04')),
    ]);
    expect(await partitionNames(app, 'orders')).toEqual([
      'orders_default',
      ...names('orders', monthRange('2026-11', '2027-04')),
    ]);
  });
});

it('[ADR-0001 §4.2 #4 并发] 两个 worker（各自的 couli_maint 连接池）同时跑三轮：全部成功、报告相同、没有失败日志，分区正好各四个', async () => {
  await withWorld(async ({ database, maint, app }) => {
    const other = createDb({ connectionString: database.urlFor('couli_maint'), max: 2 });
    try {
      const a = instanceAt(maint, '2028-02-29T12:00:00Z');
      const b = instanceAt(other, '2028-02-29T12:00:00Z');
      const months = monthRange('2028-02', '2028-05');
      const expected = {
        ensured: [...names('event_log', months), ...names('orders', months)],
        dropped: [],
        defaultRows: [],
        failed: 0,
      };
      for (let round = 0; round < 3; round += 1) {
        const results = await Promise.all([
          report(a.maintenance.runOnce()),
          report(b.maintenance.runOnce()),
        ]);
        expect(results).toEqual([expected, expected]);
      }
      expect([...a.reduced(), ...b.reduced()]).toEqual(Array(6).fill(done(8, 0, 0)));
      expect(await partitionNames(app, 'event_log')).toEqual([
        'event_log_default',
        ...names('event_log', months),
      ]);
      expect(await partitionNames(app, 'orders')).toEqual([
        'orders_default',
        ...names('orders', months),
      ]);
    } finally {
      await destroyDb(other);
    }
  });
});

it('[ADR-0001 §4.2 #16; BR-ID-30 ⑯、⑰; 规划/02 §15.1] 运行删 event_log 的过期分区（2026-10-09 00:00 +08:00 起删到 p202603），orders 的同月旧分区一个不删；日志每个删掉的分区一条，再一条 done', async () => {
  await withWorld(async ({ maint, app }) => {
    const old = monthRange('2026-02', '2026-05');
    await ensure(maint, 'event_log', old);
    await ensure(maint, 'orders', old);
    const { maintenance, reduced } = instanceAt(maint, '2026-10-08T16:00:00Z');
    const ahead = monthRange('2026-10', '2027-01');
    expect(await report(maintenance.runOnce())).toEqual({
      ensured: [...names('event_log', ahead), ...names('orders', ahead)],
      dropped: ['event_log_p202602', 'event_log_p202603'],
      defaultRows: [],
      failed: 0,
    });
    expect(reduced()).toEqual([
      line('info', 'partition_dropped', { table: 'event_log', partition: 'event_log_p202602' }),
      line('info', 'partition_dropped', { table: 'event_log', partition: 'event_log_p202603' }),
      done(8, 2, 0),
    ]);
    expect(await partitionNames(app, 'event_log')).toEqual([
      'event_log_default',
      ...names('event_log', ['2026-04', '2026-05', ...ahead]),
    ]);
    expect(await partitionNames(app, 'orders')).toEqual([
      'orders_default',
      ...names('orders', [...old, ...ahead]),
    ]);
  });
});

it('[ADR-0001 §4.2 #16; BR-ID-30 运行当日 00:00（+08:00）] 早 1 毫秒（2026-10-08 23:59:59.999 +08:00）的运行只删 p202602；运行把 now 原样交给删除函数', async () => {
  await withWorld(async ({ maint, app }) => {
    await ensure(maint, 'event_log', monthRange('2026-02', '2026-05'));
    const { maintenance, reduced } = instanceAt(maint, '2026-10-08T15:59:59.999Z');
    expect(((await report(maintenance.runOnce())) as MaintenanceReport).dropped).toEqual([
      'event_log_p202602',
    ]);
    expect(reduced()).toEqual([
      line('info', 'partition_dropped', { table: 'event_log', partition: 'event_log_p202602' }),
      done(8, 1, 0),
    ]);
    expect(await partitionNames(app, 'event_log')).toContain('event_log_p202603');
  });
});

it('[ADR-0001 §4.2 #4 DEFAULT 分区有数据即告警; contract C.3、C.5、E] DEFAULT 里有将来月份（2027-01）的 2 行：该月分区建不了，记 partition_ensure_failed（只有 SQLSTATE），其余照建；每轮告警一次（表、分区、行数）；日志与报告确切、不含行内容', async () => {
  await withWorld(async ({ maint, app }) => {
    const personal = {
      phone: '13912345678',
      real_name: '张三',
      note: 'contact 13912345678 or zhangsan@example.com',
    };
    expect(await insertEvent(app, '2027-01-15T08:00:00Z', personal)).toBe('app.event_log_default');
    expect(await insertEvent(app, '2027-01-31T23:59:59.999Z', personal)).toBe(
      'app.event_log_default',
    );
    const { maintenance, reduced, lines } = instanceAt(maint, '2026-11-20T03:04:05Z');
    const months = monthRange('2026-11', '2027-02');
    const expectedReport = {
      ensured: [
        ...names('event_log', ['2026-11', '2026-12', '2027-02']),
        ...names('orders', months),
      ],
      dropped: [],
      defaultRows: [{ table: 'event_log', partition: 'event_log_default', rows: 2 }],
      failed: 1,
    };
    const expectedLines = [
      line('error', 'partition_ensure_failed', {
        table: 'event_log',
        month: '2027-01-01',
        sqlstate: '23514',
      }),
      line('warn', 'partition_default_has_rows', {
        table: 'event_log',
        partition: 'event_log_default',
        rows: 2,
      }),
      done(7, 0, 1),
    ];
    expect(await report(maintenance.runOnce())).toEqual(expectedReport);
    expect(reduced()).toEqual(expectedLines);
    expect(await report(maintenance.runOnce())).toEqual(expectedReport);
    expect(reduced()).toEqual([...expectedLines, ...expectedLines]);
    expect(lines.join('')).not.toMatch(/13912345678|张三|zhangsan|user\.updated/);
    expect(await partitionNames(app, 'event_log')).toEqual([
      'event_log_default',
      ...names('event_log', ['2026-11', '2026-12', '2027-02']),
    ]);
  });
});

it('[ADR-0001 §4.2 #4 DEFAULT 分区有数据即告警] DEFAULT 里只有很早月份的行（2020-03）时：分区都建成，只告警、不算失败；行移走前每轮都告警', async () => {
  await withWorld(async ({ maint, app }) => {
    expect(await insertEvent(app, '2020-03-01T00:00:00Z', { order_id: 'a' })).toBe(
      'app.event_log_default',
    );
    const { maintenance, reduced } = instanceAt(maint, '2026-11-20T03:04:05Z');
    const months = monthRange('2026-11', '2027-02');
    const expectedReport = {
      ensured: [...names('event_log', months), ...names('orders', months)],
      dropped: [],
      defaultRows: [{ table: 'event_log', partition: 'event_log_default', rows: 1 }],
      failed: 0,
    };
    const alert = line('warn', 'partition_default_has_rows', {
      table: 'event_log',
      partition: 'event_log_default',
      rows: 1,
    });
    expect(await report(maintenance.runOnce())).toEqual(expectedReport);
    expect(await report(maintenance.runOnce())).toEqual(expectedReport);
    expect(reduced()).toEqual([alert, done(8, 0, 0), alert, done(8, 0, 0)]);
  });
});

it('[ADR-0001 §4.2 #4、#8 以 couli_maint 执行; contract C.1] 连接不是 couli_maint（couli_app、couli_payout、couli_readonly）时 runOnce 拒绝 wrong_role：不读时钟、不建分区、不写日志', async () => {
  await withWorld(async ({ database, app }) => {
    const got: Record<string, unknown> = {};
    for (const role of ['couli_app', 'couli_payout', 'couli_readonly'] as const) {
      const db = createDb({ connectionString: database.urlFor(role), max: 1 });
      try {
        const { maintenance, lines, clock } = instanceAt(db, '2026-11-20T03:04:05Z');
        got[role] = {
          problems: await rejectionProblems(maintenance.runOnce(), 'wrong_role'),
          clock: clock.calls(),
          lines: lines.length,
        };
      } finally {
        await destroyDb(db);
      }
    }
    const expected = { problems: [], clock: 0, lines: 0 };
    expect(got).toEqual({ couli_app: expected, couli_payout: expected, couli_readonly: expected });
    expect(await partitionNames(app, 'event_log')).toEqual(['event_log_default']);
    expect(await partitionNames(app, 'orders')).toEqual(['orders_default']);
  });
});
