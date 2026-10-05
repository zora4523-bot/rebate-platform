// Rule tests for app.drop_expired_day_partitions (B1-01s; contract section I1b in
// apps/api/src/modules/platform/maintenance/index.ts). Basis: BR-ID-30 (由每日 04:00（+08:00）删除任务按
// 分区或 created_at 执行，删除条件为 created_at < 运行当日 00:00（+08:00）− 留存天数; ② link_logs 90 天，
// 按日分区删除，不得短于 W_claim + W_backfill); ADR-0001 §4.2 #4 (couli_maint 调用 SECURITY DEFINER 函数
// 建和删分区; DEFAULT 分区兜底), #5 (link_logs 按日). Every test clones its own database.
//
// 90 days before 2026-10-08 is 2026-07-10, before 2026-10-09 it is 2026-07-11. A run on +08:00 day D
// drops the partitions of the days up to D − 91 (their upper bound D − 90 00:00 +08:00 ≤ cutoff).
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import {
  dayBound,
  dayNames,
  dayRange,
  dropDays,
  ensureDays,
  insertLinkLog,
  linkLogRows,
} from './day-kit.ts';
import {
  connect,
  disconnect,
  ensureMonths,
  names,
  partitionNames,
  partitionsOf,
  type Roles,
} from './kit.ts';

async function withDatabase(
  scenario: (roles: Roles, database: TestDatabase) => Promise<void>,
): Promise<void> {
  const database = await createTestDatabase();
  const roles = connect(database);
  try {
    await scenario(roles, database);
  } finally {
    await disconnect(roles);
    await database.drop();
  }
}

// 2026-10-08 23:59:59.999 at +08:00: cutoff 2026-07-10 00:00 +08:00 (= 2026-07-09T16:00Z).
const LAST_MS_OF_OCT_8 = '2026-10-08T15:59:59.999Z';
// 2026-10-09 00:00:00.000 at +08:00: cutoff 2026-07-11 00:00 +08:00 (= 2026-07-10T16:00Z).
const FIRST_MS_OF_OCT_9 = '2026-10-08T16:00:00.000Z';

it('[BR-ID-30 ② 90 天、运行当日 00:00（+08:00）; contract I1b] 2026-10-08 23:59:59.999（+08:00）删到 p20260709、保留 p20260710；再晚 1 毫秒删 p20260710；p20260711 起与 DEFAULT 不动；返回值确切、升序，重复调用返回空数组', async () => {
  await withDatabase(async ({ maint }) => {
    const days = dayRange('2026-07-07', '2026-07-12');
    expect(await ensureDays(maint, 'link_logs', days)).toEqual(dayNames('link_logs', days));
    expect(await dropDays(maint, 'link_logs', LAST_MS_OF_OCT_8)).toEqual(
      dayNames('link_logs', dayRange('2026-07-07', '2026-07-09')),
    );
    expect(await dropDays(maint, 'link_logs', LAST_MS_OF_OCT_8)).toEqual([]);
    expect(await partitionNames(maint, 'link_logs')).toEqual([
      'link_logs_default',
      ...dayNames('link_logs', dayRange('2026-07-10', '2026-07-12')),
    ]);
    expect(await dropDays(maint, 'link_logs', FIRST_MS_OF_OCT_9)).toEqual(['link_logs_p20260710']);
    expect(await dropDays(maint, 'link_logs', FIRST_MS_OF_OCT_9)).toEqual([]);
    expect(await partitionsOf(maint, 'link_logs')).toEqual([
      { name: 'link_logs_default', bound: 'DEFAULT' },
      { name: 'link_logs_p20260711', bound: dayBound('2026-07-11') },
      { name: 'link_logs_p20260712', bound: dayBound('2026-07-12') },
    ]);
  });
});

it('[BR-ID-30 ② 90 天] 跨年与闰年：2027-03-31 23:59:59.999（+08:00，截止 2026-12-31 00:00 +08:00）删到 p20261230；再晚 1 毫秒删 p20261231；2028-05-29 00:00（+08:00）的截止是 2028-02-29 00:00，删到 p20280228、保留 p20280229', async () => {
  await withDatabase(async ({ maint }) => {
    const winter = dayRange('2026-12-29', '2027-01-01');
    const leap = ['2028-02-28', '2028-02-29', '2028-03-01'];
    expect(await ensureDays(maint, 'link_logs', [...winter, ...leap])).toEqual(
      dayNames('link_logs', [...winter, ...leap]),
    );
    expect(await dropDays(maint, 'link_logs', '2027-03-31T15:59:59.999Z')).toEqual([
      'link_logs_p20261229',
      'link_logs_p20261230',
    ]);
    expect(await dropDays(maint, 'link_logs', '2027-03-31T16:00:00.000Z')).toEqual([
      'link_logs_p20261231',
    ]);
    expect(await dropDays(maint, 'link_logs', '2028-05-28T16:00:00.000Z')).toEqual([
      'link_logs_p20270101',
      'link_logs_p20280228',
    ]);
    expect(await partitionNames(maint, 'link_logs')).toEqual([
      'link_logs_default',
      'link_logs_p20280229',
      'link_logs_p20280301',
    ]);
  });
});

it('[BR-ID-30 运行当日 00:00（+08:00）; contract I1b] 截止只看 p_now 在 +08:00 的日期：会话时区 Pacific/Kiritimati（+14）或 America/New_York 时结果同上；p_now 以 −04:00 偏移写出也一样', async () => {
  await withDatabase(async ({ maint }) => {
    const days = dayRange('2026-07-09', '2026-07-11');
    expect(await ensureDays(maint, 'link_logs', days)).toEqual(dayNames('link_logs', days));
    const inZone = async (zone: string, now: string): Promise<string[]> =>
      maint
        .transaction()
        .execute(async (trx) => {
          await sql`SELECT set_config('TimeZone', ${zone}, true)`.execute(trx);
          const result = await sql<{ names: string[] }>`
            SELECT app.drop_expired_day_partitions('link_logs', ${now}::timestamptz) AS names
          `.execute(trx);
          return result.rows[0]?.names ?? ['no row'];
        })
        .catch((error: unknown) => [`failed ${String((error as { code?: unknown }).code)}`]);
    // 2026-10-09 05:59:59.999 in Kiritimati, still 2026-10-08 at +08:00.
    expect(await inZone('Pacific/Kiritimati', LAST_MS_OF_OCT_8)).toEqual(['link_logs_p20260709']);
    // 2026-10-08 12:00 in New York, already 2026-10-09 00:00 at +08:00.
    expect(await inZone('America/New_York', '2026-10-08T12:00:00.000-04:00')).toEqual([
      'link_logs_p20260710',
    ]);
    expect(await partitionNames(maint, 'link_logs')).toEqual([
      'link_logs_default',
      'link_logs_p20260711',
    ]);
  });
});

it('[BR-ID-30 删除条件 created_at < 截止; contract I1b] 删掉的分区连同其中的行（含当日最后 1 毫秒的行）一起消失；截止当日分区里第 1 毫秒的行与 DEFAULT 里很早的行都保留', async () => {
  await withDatabase(async ({ maint, app }) => {
    const days = ['2026-07-10', '2026-07-11'];
    expect(await ensureDays(maint, 'link_logs', days)).toEqual(dayNames('link_logs', days));
    expect({
      lastMsOfJul10: await insertLinkLog(app, '2026-07-10T15:59:59.999Z'),
      firstMsOfJul11: await insertLinkLog(app, '2026-07-11T00:00:00.000+08:00'),
      veryOld: await insertLinkLog(app, '2019-01-01T00:00:00Z'),
    }).toEqual({
      lastMsOfJul10: 'app.link_logs_p20260710',
      firstMsOfJul11: 'app.link_logs_p20260711',
      veryOld: 'app.link_logs_default',
    });
    expect(await dropDays(maint, 'link_logs', FIRST_MS_OF_OCT_9)).toEqual(['link_logs_p20260710']);
    expect(await linkLogRows(app)).toEqual([
      { part: 'app.link_logs_default', at: '2019-01-01T00:00:00.000Z' },
      { part: 'app.link_logs_p20260711', at: '2026-07-10T16:00:00.000Z' },
    ]);
  });
});

it('[ADR-0001 §4.2 #4 DEFAULT 兜底; 规划/02 §15.1] 很远的 p_now 删掉 link_logs 的全部日分区（升序），DEFAULT 及其行保留；event_log 与 orders 的旧月分区一个不动', async () => {
  await withDatabase(async ({ maint, app }) => {
    const days = ['2020-01-31', '2020-02-01', '2024-02-29', '2025-12-31'];
    expect(await ensureDays(maint, 'link_logs', days)).toEqual(dayNames('link_logs', days));
    await ensureMonths(maint, 'event_log', ['2020-01']);
    await ensureMonths(maint, 'orders', ['2020-01']);
    expect(await insertLinkLog(app, '2035-01-01T00:00:00Z')).toBe('app.link_logs_default');
    expect(await dropDays(maint, 'link_logs', '2100-01-01T00:00:00Z')).toEqual(
      dayNames('link_logs', days),
    );
    expect(await partitionNames(maint, 'link_logs')).toEqual(['link_logs_default']);
    expect(await linkLogRows(app)).toEqual([
      { part: 'app.link_logs_default', at: '2035-01-01T00:00:00.000Z' },
    ]);
    expect(await partitionNames(maint, 'event_log')).toEqual([
      'event_log_default',
      ...names('event_log', ['2020-01']),
    ]);
    expect(await partitionNames(maint, 'orders')).toEqual([
      'orders_default',
      ...names('orders', ['2020-01']),
    ]);
  });
});

it('[contract I1b] 没有可删的分区时返回空数组（不是 NULL）：只有 DEFAULT 时、全部日分区都在留存期内时', async () => {
  await withDatabase(async ({ maint }) => {
    expect(await dropDays(maint, 'link_logs', '2100-01-01T00:00:00Z')).toEqual([]);
    expect(await ensureDays(maint, 'link_logs', ['2026-07-11'])).toEqual(['link_logs_p20260711']);
    expect(await dropDays(maint, 'link_logs', FIRST_MS_OF_OCT_9)).toEqual([]);
    expect(await partitionNames(maint, 'link_logs')).toEqual([
      'link_logs_default',
      'link_logs_p20260711',
    ]);
  });
});

it('[ADR-0001 §4.2 #4 并发; contract I1b] 六个会话同时删 30 个过期日分区：全部成功，每个分区正好被删、被报告一次，最后只剩 DEFAULT', async () => {
  await withDatabase(async ({ maint }, database) => {
    const days = dayRange('2024-01-01', '2024-01-30');
    expect(await ensureDays(maint, 'link_logs', days)).toEqual(dayNames('link_logs', days));
    const sessions = Array.from({ length: 6 }, () =>
      createDb({ connectionString: database.urlFor('couli_maint'), max: 1 }),
    );
    try {
      const results = await Promise.all(
        sessions.map((db) => dropDays(db, 'link_logs', '2100-01-01T00:00:00Z')),
      );
      expect(results.filter((r) => typeof r === 'string')).toEqual([]);
      const reported = results.flatMap((r) => (typeof r === 'string' ? [] : r)).sort();
      expect(reported).toEqual(dayNames('link_logs', days));
    } finally {
      await Promise.all(sessions.map((db) => destroyDb(db)));
    }
    expect(await partitionNames(maint, 'link_logs')).toEqual(['link_logs_default']);
  });
});

it('[ADR-0001 §4.2 #4 并发; contract I1a、I1b] 删除与预建同时进行（各三个会话，日子互不相同）：全部成功，过期的 10 天正好各删一次，新的 10 天正好各建一次', async () => {
  await withDatabase(async ({ maint }, database) => {
    const old = dayRange('2024-03-01', '2024-03-10');
    const fresh = dayRange('2030-03-01', '2030-03-10');
    expect(await ensureDays(maint, 'link_logs', old)).toEqual(dayNames('link_logs', old));
    const sessions = Array.from({ length: 6 }, () =>
      createDb({ connectionString: database.urlFor('couli_maint'), max: 1 }),
    );
    try {
      const results = await Promise.all(
        sessions.map((db, i) =>
          i % 2 === 0
            ? dropDays(db, 'link_logs', '2029-01-01T00:00:00Z')
            : ensureDays(db, 'link_logs', fresh),
        ),
      );
      const drops = results.filter((_, i) => i % 2 === 0);
      const creates = results.filter((_, i) => i % 2 === 1);
      expect(drops.filter((r) => typeof r === 'string')).toEqual([]);
      expect(drops.flatMap((r) => (typeof r === 'string' ? [] : r)).sort()).toEqual(
        dayNames('link_logs', old),
      );
      expect(creates).toEqual(Array(3).fill(dayNames('link_logs', fresh)));
    } finally {
      await Promise.all(sessions.map((db) => destroyDb(db)));
    }
    expect(await partitionNames(maint, 'link_logs')).toEqual([
      'link_logs_default',
      ...dayNames('link_logs', fresh),
    ]);
  });
});
