// Rule tests of a maintenance run with day partitions on (B1-01s; contract section I2 with C and E in
// apps/api/src/modules/platform/maintenance/index.ts). Basis: ADR-0001 §4.2 #4 (按日的表预建未来 14 天;
// DEFAULT 分区有数据即告警，须先迁出才能建分区), #5 (link_logs 按日), #10 (时钟只读注入); BR-ID-30 (由每日
// 04:00（+08:00）删除任务执行，删除条件 created_at < 运行当日 00:00（+08:00）− 留存天数; ② link_logs 90 天、
// 按日分区删除). Every test clones its own database; the module connects as couli_maint.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import type {
  MaintenanceReport,
  PartitionMaintenanceOptions,
} from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import {
  dayBound,
  dayNames,
  dayRange,
  ensureDays,
  insertLinkLog,
} from '../../db/partitions/day-kit.ts';
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

/** A maintenance instance on `db` at the fixed instant `now` (day partitions on unless overridden). */
function instanceAt(
  db: Kysely<DB>,
  now: string,
  extra: Partial<PartitionMaintenanceOptions> = { dayPartitions: true },
) {
  const { logger, lines } = memoryLogger();
  const clock = countingClock(now);
  const maintenance = createOrStub({ db, logger, clock, ...extra });
  return { maintenance, lines, clock, reduced: () => lines.map(reduceLine) };
}

async function report(run: Promise<MaintenanceReport>): Promise<unknown> {
  try {
    return { ...(await run) };
  } catch (error) {
    return { error: String(error) };
  }
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

/** Month partitions of `months` as couli_maint, outside the module (test setup). */
async function ensureMonths(maint: Kysely<DB>, table: string, months: readonly string[]) {
  for (const month of months) {
    await sql`SELECT app.ensure_month_partition(${table}, ${`${month}-01`}::date)`.execute(maint);
  }
}

const MONTHS_NOV = monthRange('2026-11', '2027-02');
const MONTH_NAMES_NOV = [...names('event_log', MONTHS_NOV), ...names('orders', MONTHS_NOV)];

it('[ADR-0001 §4.2 #4 按日的表预建未来 14 天、#5; contract I2 C.3b] 新库上一次运行（时钟 2026-11-20T03:04:05Z，+08:00 的 11:04）：先建 8 个月分区，再建 link_logs 2026-11-20 至 2026-12-04 共 15 个日分区（界确切）；报告与日志确切，时钟只读一次；再跑一次报告相同', async () => {
  await withWorld(async ({ maint, app }) => {
    const { maintenance, clock, reduced } = instanceAt(maint, '2026-11-20T03:04:05Z');
    const days = dayRange('2026-11-20', '2026-12-04');
    const expected = {
      ensured: [...MONTH_NAMES_NOV, ...dayNames('link_logs', days)],
      dropped: [],
      defaultRows: [],
      failed: 0,
    };
    expect(await report(maintenance.runOnce())).toEqual(expected);
    expect(clock.calls()).toBe(1);
    expect(await partitionsOf(app, 'link_logs')).toEqual([
      { name: 'link_logs_default', bound: 'DEFAULT' },
      ...days.map((d) => ({ name: dayNames('link_logs', [d])[0], bound: dayBound(d) })),
    ]);
    expect(await partitionNames(app, 'event_log')).toEqual([
      'event_log_default',
      ...names('event_log', MONTHS_NOV),
    ]);
    expect(reduced()).toEqual([done(23, 0, 0)]);
    expect(await report(maintenance.runOnce())).toEqual(expected);
    expect(reduced()).toEqual([done(23, 0, 0), done(23, 0, 0)]);
    expect(await partitionNames(app, 'link_logs')).toHaveLength(16);
  });
});

it('[BR-ID-30 +08:00 日界; ADR-0001 §4.2 #10; contract I2] 日子按 +08:00 的自然日：2026-11-19T15:59:59.999Z（+08:00 的 11-19 最后 1 毫秒）建 11-19 至 12-03；再晚 1 毫秒的运行列出 11-20 至 12-04（已有的照样列出）、只新增 12-04；月分区仍按 UTC 月', async () => {
  await withWorld(async ({ maint, app }) => {
    const first = instanceAt(maint, '2026-11-19T15:59:59.999Z');
    expect(await report(first.maintenance.runOnce())).toEqual({
      ensured: [...MONTH_NAMES_NOV, ...dayNames('link_logs', dayRange('2026-11-19', '2026-12-03'))],
      dropped: [],
      defaultRows: [],
      failed: 0,
    });
    const second = instanceAt(maint, '2026-11-19T16:00:00.000Z');
    expect(await report(second.maintenance.runOnce())).toEqual({
      ensured: [...MONTH_NAMES_NOV, ...dayNames('link_logs', dayRange('2026-11-20', '2026-12-04'))],
      dropped: [],
      defaultRows: [],
      failed: 0,
    });
    expect([...first.reduced(), ...second.reduced()]).toEqual([done(23, 0, 0), done(23, 0, 0)]);
    expect(await partitionNames(app, 'link_logs')).toEqual([
      'link_logs_default',
      ...dayNames('link_logs', dayRange('2026-11-19', '2026-12-04')),
    ]);
  });
});

it('[contract I2 默认关闭] dayPartitions 为 false 或不给：与原来逐字相同——只建 8 个月分区、04:00 后也不删 link_logs 的过期日分区、done(8, 0, 0)', async () => {
  await withWorld(async ({ maint, app }) => {
    const old = dayRange('2026-07-08', '2026-07-10');
    expect(await ensureDays(maint, 'link_logs', old)).toEqual(dayNames('link_logs', old));
    const ahead = monthRange('2026-10', '2027-01');
    const expected = {
      ensured: [...names('event_log', ahead), ...names('orders', ahead)],
      dropped: [],
      defaultRows: [],
      failed: 0,
    };
    const results: unknown[] = [];
    const logs: unknown[] = [];
    for (const extra of [{ dayPartitions: false }, {}]) {
      const run = instanceAt(maint, '2026-10-08T20:00:00.000Z', extra);
      results.push(await report(run.maintenance.runOnce()));
      logs.push(...run.reduced());
    }
    expect(results).toEqual([expected, expected]);
    expect(logs).toEqual([done(8, 0, 0), done(8, 0, 0)]);
    expect(await partitionNames(app, 'link_logs')).toEqual([
      'link_logs_default',
      ...dayNames('link_logs', old),
    ]);
  });
});

it('[ADR-0001 §4.2 #4 DEFAULT 有数据须先迁出才能建分区、有数据即告警; contract I2 C.3b、E] link_logs_default 里有 2026-11-25（+08:00）的 1 行：该日建不了，记 partition_ensure_failed { table, day, sqlstate }，其余 14 天照建；告警 link_logs 1 行；报告与日志确切、不含行内容', async () => {
  await withWorld(async ({ maint, app }) => {
    expect(await insertLinkLog(app, '2026-11-25T08:00:00+08:00')).toBe('app.link_logs_default');
    const { maintenance, reduced, lines } = instanceAt(maint, '2026-11-20T03:04:05Z');
    const days = dayRange('2026-11-20', '2026-12-04').filter((d) => d !== '2026-11-25');
    expect(await report(maintenance.runOnce())).toEqual({
      ensured: [...MONTH_NAMES_NOV, ...dayNames('link_logs', days)],
      dropped: [],
      defaultRows: [{ table: 'link_logs', partition: 'link_logs_default', rows: 1 }],
      failed: 1,
    });
    expect(reduced()).toEqual([
      line('error', 'partition_ensure_failed', {
        table: 'link_logs',
        day: '2026-11-25',
        sqlstate: '23514',
      }),
      line('warn', 'partition_default_has_rows', {
        table: 'link_logs',
        partition: 'link_logs_default',
        rows: 1,
      }),
      done(22, 0, 1),
    ]);
    expect(lines.join('')).not.toMatch(/item-/);
    expect(await partitionNames(app, 'link_logs')).toEqual([
      'link_logs_default',
      ...dayNames('link_logs', days),
    ]);
  });
});

it('[BR-ID-30 每日 04:00（+08:00）删除任务、② 90 天; contract I2 C.4] 03:59:59.999（+08:00）的运行只预建、不删；04:00:00.000 的运行先删 event_log 的过期月分区、再删 link_logs 2026-07-08 至 07-10（截止 2026-07-11 00:00 +08:00），07-11 保留；每个删掉的分区一条日志', async () => {
  await withWorld(async ({ maint, app }) => {
    const old = dayRange('2026-07-08', '2026-07-11');
    expect(await ensureDays(maint, 'link_logs', old)).toEqual(dayNames('link_logs', old));
    await ensureMonths(maint, 'event_log', ['2026-02', '2026-03']);
    const months = monthRange('2026-10', '2027-01');
    const monthNames = [...names('event_log', months), ...names('orders', months)];

    // 2026-10-09 03:59:59.999 +08:00: days 2026-10-09 … 2026-10-23.
    const before = instanceAt(maint, '2026-10-08T19:59:59.999Z');
    expect(await report(before.maintenance.runOnce())).toEqual({
      ensured: [...monthNames, ...dayNames('link_logs', dayRange('2026-10-09', '2026-10-23'))],
      dropped: [],
      defaultRows: [],
      failed: 0,
    });
    expect(before.reduced()).toEqual([done(23, 0, 0)]);
    expect(await partitionNames(app, 'link_logs')).toEqual([
      'link_logs_default',
      ...dayNames('link_logs', [...old, ...dayRange('2026-10-09', '2026-10-23')]),
    ]);

    // 2026-10-09 04:00:00.000 +08:00: the same 15 days, listed again.
    const atFour = instanceAt(maint, '2026-10-08T20:00:00.000Z');
    const gone = dayNames('link_logs', dayRange('2026-07-08', '2026-07-10'));
    expect(await report(atFour.maintenance.runOnce())).toEqual({
      ensured: [...monthNames, ...dayNames('link_logs', dayRange('2026-10-09', '2026-10-23'))],
      dropped: ['event_log_p202602', 'event_log_p202603', ...gone],
      defaultRows: [],
      failed: 0,
    });
    const dropLine = (table: string, partition: string) =>
      line('info', 'partition_dropped', { table, partition });
    expect(atFour.reduced()).toEqual([
      dropLine('event_log', 'event_log_p202602'),
      dropLine('event_log', 'event_log_p202603'),
      ...gone.map((p) => dropLine('link_logs', p)),
      done(23, 5, 0),
    ]);
    expect(await partitionNames(app, 'link_logs')).toEqual([
      'link_logs_default',
      ...dayNames('link_logs', ['2026-07-11', ...dayRange('2026-10-09', '2026-10-23')]),
    ]);
  });
});

it('[BR-ID-30 运行当日 00:00（+08:00）; contract I2 C.4] 运行把 now 原样交给删除函数：2026-10-08 23:59:59.999（+08:00）的运行删到 link_logs_p20260709，p20260710 保留', async () => {
  await withWorld(async ({ maint, app }) => {
    const old = dayRange('2026-07-09', '2026-07-10');
    expect(await ensureDays(maint, 'link_logs', old)).toEqual(dayNames('link_logs', old));
    const run = instanceAt(maint, '2026-10-08T15:59:59.999Z');
    expect(((await report(run.maintenance.runOnce())) as MaintenanceReport).dropped).toEqual([
      'link_logs_p20260709',
    ]);
    expect(run.reduced()).toEqual([
      line('info', 'partition_dropped', { table: 'link_logs', partition: 'link_logs_p20260709' }),
      done(23, 1, 0),
    ]);
    expect(await partitionNames(app, 'link_logs')).toContain('link_logs_p20260710');
  });
});

it('[ADR-0001 §4.2 #4 并发; contract I2] 两个 worker（各自的 couli_maint 连接池）同时跑两轮：全部成功、报告相同、没有失败日志，日分区正好 15 个', async () => {
  await withWorld(async ({ database, maint, app }) => {
    const other = createDb({ connectionString: database.urlFor('couli_maint'), max: 2 });
    try {
      const a = instanceAt(maint, '2028-02-20T12:00:00Z');
      const b = instanceAt(other, '2028-02-20T12:00:00Z');
      const months = monthRange('2028-02', '2028-05');
      const days = dayRange('2028-02-20', '2028-03-05');
      const expected = {
        ensured: [
          ...names('event_log', months),
          ...names('orders', months),
          ...dayNames('link_logs', days),
        ],
        dropped: [],
        defaultRows: [],
        failed: 0,
      };
      for (let round = 0; round < 2; round += 1) {
        const results = await Promise.all([
          report(a.maintenance.runOnce()),
          report(b.maintenance.runOnce()),
        ]);
        expect(results).toEqual([expected, expected]);
      }
      expect([...a.reduced(), ...b.reduced()]).toEqual(Array(4).fill(done(23, 0, 0)));
      expect(await partitionNames(app, 'link_logs')).toEqual([
        'link_logs_default',
        ...dayNames('link_logs', days),
      ]);
    } finally {
      await destroyDb(other);
    }
  });
});
