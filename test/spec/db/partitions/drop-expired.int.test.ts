// Rule tests for app.drop_expired_month_partitions (B1-01j; contract section A1 in
// apps/api/src/modules/platform/maintenance/index.ts). Basis: ADR-0001 §4.2 #4 (couli_maint 调用
// couli_migrator 所有的 SECURITY DEFINER 函数建和删分区), #16 (event_log 留存 ≥190 天); 规划/02 §15.1
// (orders 等订单类表与 ledger_entries 的分区只预建、不删除); BR-ID-30 (删除条件 created_at < 运行当日
// 00:00（+08:00）− 留存天数; ⑫ 账务记录与 ⑰ 订单类记录确认前不删除分区; ⑯ event_log 190 天).
// Every test clones its own database, so the partition lists start from the migrations alone.
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import {
  connect,
  disconnect,
  dropExpired,
  dropped,
  ensureMonths,
  insertEvents,
  monthBound,
  monthRange,
  names,
  outcome,
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

// 2026-10-08T15:59:59.999Z is 2026-10-08 23:59:59.999 at +08:00: cutoff 2026-04-01 00:00 +08:00
// (= 2026-03-31T16:00Z), so event_log_p202603 (up to 2026-04-01T00:00Z) still holds rows that are
// not older than the cutoff. One millisecond later the +08:00 date is 2026-10-09: cutoff
// 2026-04-02 00:00 +08:00 (= 2026-04-01T16:00Z), past the whole of March.
const LAST_MS_OF_OCT_8 = '2026-10-08T15:59:59.999Z';
const FIRST_MS_OF_OCT_9 = '2026-10-08T16:00:00.000Z';

it('[ADR-0001 §4.2 #16; BR-ID-30 ⑯] event_log 留存 190 天按 +08:00 日界：2026-10-08 23:59:59.999（+08:00）只删 p202602、保留 p202603；再晚 1 毫秒删 p202603；p202604、p202605 与 DEFAULT 不动，返回值确切、重复调用返回空数组', async () => {
  await withDatabase(async ({ maint }) => {
    await ensureMonths(maint, 'event_log', monthRange('2026-02', '2026-05'));
    expect(await dropped(maint, 'event_log', LAST_MS_OF_OCT_8)).toEqual(['event_log_p202602']);
    expect(await partitionNames(maint, 'event_log')).toEqual([
      'event_log_default',
      ...names('event_log', monthRange('2026-03', '2026-05')),
    ]);
    expect(await dropped(maint, 'event_log', LAST_MS_OF_OCT_8)).toEqual([]);
    expect(await dropped(maint, 'event_log', FIRST_MS_OF_OCT_9)).toEqual(['event_log_p202603']);
    expect(await dropped(maint, 'event_log', FIRST_MS_OF_OCT_9)).toEqual([]);
    expect(await partitionsOf(maint, 'event_log')).toEqual([
      { name: 'event_log_default', bound: 'DEFAULT' },
      { name: 'event_log_p202604', bound: monthBound('2026-04') },
      { name: 'event_log_p202605', bound: monthBound('2026-05') },
    ]);
  });
});

it('[ADR-0001 §4.2 #16; BR-ID-30 ⑯] 跨年的边界：2026-07-10 23:59:59.999（+08:00）只删 p202511（截止 2026-01-01 00:00 +08:00），再晚 1 毫秒删 p202512；p202601、p202602 保留', async () => {
  await withDatabase(async ({ maint }) => {
    await ensureMonths(maint, 'event_log', monthRange('2025-11', '2026-02'));
    expect(await dropped(maint, 'event_log', '2026-07-10T15:59:59.999Z')).toEqual([
      'event_log_p202511',
    ]);
    expect(await dropped(maint, 'event_log', '2026-07-10T16:00:00.000Z')).toEqual([
      'event_log_p202512',
    ]);
    expect(await partitionNames(maint, 'event_log')).toEqual([
      'event_log_default',
      ...names('event_log', ['2026-01', '2026-02']),
    ]);
  });
});

it('[BR-ID-30 运行当日 00:00（+08:00）] 截止时刻只看 p_now 在 +08:00 的日期：会话时区为 Pacific/Kiritimati（+14）或 America/New_York（−4）时结果与上面相同；p_now 以别的偏移写出也一样', async () => {
  await withDatabase(async ({ maint }) => {
    await ensureMonths(maint, 'event_log', monthRange('2026-02', '2026-05'));
    const inZone = async (zone: string, now: string): Promise<string[]> =>
      maint
        .transaction()
        .execute(async (trx) => {
          await sql`SELECT set_config('TimeZone', ${zone}, true)`.execute(trx);
          const result = await sql<{ names: string[] }>`
          SELECT app.drop_expired_month_partitions('event_log', ${now}::timestamptz) AS names
        `.execute(trx);
          return result.rows[0]?.names ?? ['no row'];
        })
        .catch((error: unknown) => [`failed ${String((error as { code?: unknown }).code)}`]);
    // 2026-10-09 05:59:59.999 in Kiritimati, still 2026-10-08 at +08:00.
    expect(await inZone('Pacific/Kiritimati', LAST_MS_OF_OCT_8)).toEqual(['event_log_p202602']);
    // 2026-10-08 12:00 in New York, already 2026-10-09 at +08:00; written with a -04:00 offset.
    expect(await inZone('America/New_York', '2026-10-08T12:00:00.000-04:00')).toEqual([
      'event_log_p202603',
    ]);
    expect(await partitionNames(maint, 'event_log')).toEqual([
      'event_log_default',
      ...names('event_log', ['2026-04', '2026-05']),
    ]);
  });
});

it('[ADR-0001 §4.2 #4 DEFAULT 兜底; 规划/02 §15.1] 很远的 p_now 删掉 event_log 的全部月分区（升序返回），DEFAULT 分区及其数据保留；orders 的分区一个不少', async () => {
  await withDatabase(async ({ maint, app }) => {
    const months = monthRange('2025-12', '2026-03');
    await ensureMonths(maint, 'event_log', months);
    await ensureMonths(maint, 'orders', months);
    expect(await insertEvents(app, '2031-05-05T05:05:05Z', 2)).toEqual([
      'app.event_log_default',
      'app.event_log_default',
    ]);
    expect(await insertEvents(app, '2026-01-15T00:00:00Z', 1)).toEqual(['app.event_log_p202601']);
    expect(await dropped(maint, 'event_log', '2100-01-01T00:00:00Z')).toEqual(
      names('event_log', months),
    );
    expect(await partitionNames(maint, 'event_log')).toEqual(['event_log_default']);
    const left = await sql<{ n: bigint }>`SELECT count(*) AS n FROM app.event_log`.execute(app);
    expect(left.rows[0]?.n).toBe(2n);
    expect(await partitionNames(maint, 'orders')).toEqual([
      'orders_default',
      ...names('orders', months),
    ]);
  });
});

it('[ADR-0001 §4.2 #4] 没有可删的分区时返回空数组（不是 NULL）：只有 DEFAULT 时、全部分区都在留存期内时', async () => {
  await withDatabase(async ({ maint }) => {
    expect(await dropped(maint, 'event_log', '2100-01-01T00:00:00Z')).toEqual([]);
    await ensureMonths(maint, 'event_log', ['2026-04']);
    expect(await dropped(maint, 'event_log', LAST_MS_OF_OCT_8)).toEqual([]);
    expect(await partitionNames(maint, 'event_log')).toEqual([
      'event_log_default',
      'event_log_p202604',
    ]);
  });
});

/** BR-ID-30 ⑫ 账务记录、⑰ 订单类记录 and ⑧ audit_logs: no deletion before the period is confirmed. */
const RETAINED = [
  'orders',
  'order_keys',
  'order_status_history',
  'order_rights',
  'order_settlements',
  'commission_splits',
  'settle_bills',
  'settle_batches',
  'settle_batch_items',
  'settle_adjustments',
  'claims',
  'claim_items',
  'ledger_vouchers',
  'ledger_entries',
  'withdrawals',
  'payout_attempts',
  'audit_logs',
];

it('[规划/02 §15.1; BR-ID-30 ⑫、⑰] orders 等订单类表与 ledger_entries 等账务表（含尚不存在的表）一律拒绝：55000 与确切文案，orders 与 event_log 的旧分区都还在', async () => {
  await withDatabase(async ({ maint }) => {
    const months = monthRange('2020-01', '2020-02');
    await ensureMonths(maint, 'orders', months);
    await ensureMonths(maint, 'event_log', months);
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const table of RETAINED) {
      got[table] = await outcome(dropExpired(maint, table, '2100-01-01T00:00:00Z'));
      want[table] =
        `55000 drop_expired_month_partitions: partitions of app.${table} are kept until their retention period is confirmed`;
    }
    expect(got).toEqual(want);
    expect(await partitionNames(maint, 'orders')).toEqual([
      'orders_default',
      ...names('orders', months),
    ]);
    expect(await partitionNames(maint, 'event_log')).toEqual([
      'event_log_default',
      ...names('event_log', months),
    ]);
  });
});

it('[ADR-0001 §4.2 #4; 规划/02 §15.1] 没有留存规则的名字一律拒绝（22023 与确切文案）：link_logs、分区名、大小写或空白不同、带 schema、空串、不存在的表；什么都不删', async () => {
  await withDatabase(async ({ maint }) => {
    await ensureMonths(maint, 'event_log', ['2020-01']);
    await ensureMonths(maint, 'orders', ['2020-01']);
    const others = [
      'link_logs',
      'events',
      'event_log_default',
      'event_log_p202001',
      'orders_p202001',
      'orders_default',
      'EVENT_LOG',
      'Event_Log',
      ' event_log',
      'event_log ',
      'app.event_log',
      '"event_log"',
      'ORDERS',
      'Ledger_Entries',
      ' orders',
      'no_such_table',
      '',
    ];
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const table of others) {
      got[table] = await outcome(dropExpired(maint, table, '2100-01-01T00:00:00Z'));
      want[table] =
        `22023 drop_expired_month_partitions: table "${table}" has no partition retention rule`;
    }
    expect(got).toEqual(want);
    expect(await partitionNames(maint, 'event_log')).toEqual([
      'event_log_default',
      'event_log_p202001',
    ]);
    expect(await partitionNames(maint, 'orders')).toEqual(['orders_default', 'orders_p202001']);
  });
});

it('[contract A1 a、b] 参数为 NULL 时 22004、p_now 为 ±infinity 时 22023，文案确切，什么都不删；NULL 检查先于名单检查', async () => {
  await withDatabase(async ({ maint }) => {
    await ensureMonths(maint, 'event_log', ['2020-01']);
    const required = '22004 drop_expired_month_partitions: p_table and p_now are required';
    const finite = '22023 drop_expired_month_partitions: p_now must be finite';
    expect({
      nullTable: await outcome(dropExpired(maint, null, '2100-01-01T00:00:00Z')),
      nullNow: await outcome(dropExpired(maint, 'event_log', null)),
      nullNowRetained: await outcome(dropExpired(maint, 'orders', null)),
      nullBoth: await outcome(dropExpired(maint, null, null)),
      infinity: await outcome(dropExpired(maint, 'event_log', 'infinity')),
      minusInfinity: await outcome(dropExpired(maint, 'event_log', '-infinity')),
      infinityRetained: await outcome(dropExpired(maint, 'ledger_entries', 'infinity')),
    }).toEqual({
      nullTable: required,
      nullNow: required,
      nullNowRetained: required,
      nullBoth: required,
      infinity: finite,
      minusInfinity: finite,
      infinityRetained: finite,
    });
    expect(await partitionNames(maint, 'event_log')).toEqual([
      'event_log_default',
      'event_log_p202001',
    ]);
  });
});

it('[ADR-0001 §4.2 #4 并发] 六个会话同时删 24 个过期分区：全部成功，每个分区正好被删、被报告一次，最后只剩 DEFAULT', async () => {
  await withDatabase(async ({ maint }, database) => {
    const months = monthRange('2023-01', '2024-12');
    await ensureMonths(maint, 'event_log', months);
    // Six independent sessions: six pools of one connection each, all couli_maint.
    const sessions = Array.from({ length: 6 }, () =>
      createDb({ connectionString: database.urlFor('couli_maint'), max: 1 }),
    );
    try {
      const results = await Promise.all(
        sessions.map(async (db) => {
          try {
            return await dropExpired(db, 'event_log', '2100-01-01T00:00:00Z');
          } catch (error) {
            return `failed: ${String((error as { code?: unknown }).code)}`;
          }
        }),
      );
      expect(results.filter((r) => typeof r === 'string')).toEqual([]);
      const reported = results.flatMap((r) => (typeof r === 'string' ? [] : r)).sort();
      expect(reported).toEqual(names('event_log', months));
    } finally {
      await Promise.all(sessions.map((db) => destroyDb(db)));
    }
    expect(await partitionNames(maint, 'event_log')).toEqual(['event_log_default']);
  });
});

it('[BR-ID-30 删除条件 created_at < 截止; contract A1 (ii)] 分区按 occurred_at 已过期、但里面有一行 created_at 恰好等于后来的截止时刻（2026-10-08T16:00Z）：该分区整个保留到 p_now 2027-04-17T15:59:59.999Z（截止 = created_at，不算更早），2027-04-17T16:00Z 起才删；同期没有新行的分区照常按上界删', async () => {
  await withDatabase(async ({ maint, app }) => {
    await ensureMonths(maint, 'event_log', ['2026-02', '2026-03']);
    const inserted = await sql<{ part: string }>`
      INSERT INTO app.event_log (app_id, event_id, name, payload, occurred_at, created_at)
      VALUES ('couli', '00000000-0000-7000-8000-00000000c0de'::uuid, 'order.created',
              '{"order_id": "late"}'::jsonb, '2026-03-31T12:00:00Z'::timestamptz,
              '2026-10-08T16:00:00Z'::timestamptz)
      RETURNING tableoid::regclass::text AS part
    `.execute(app);
    expect(inserted.rows[0]?.part).toBe('app.event_log_p202603');
    expect(await dropped(maint, 'event_log', FIRST_MS_OF_OCT_9)).toEqual(['event_log_p202602']);
    expect(await dropped(maint, 'event_log', '2027-04-16T15:59:59.999Z')).toEqual([]);
    expect(await dropped(maint, 'event_log', '2027-04-16T16:00:00.000Z')).toEqual([]);
    expect(await dropped(maint, 'event_log', '2027-04-17T15:59:59.999Z')).toEqual([]);
    expect(await partitionNames(maint, 'event_log')).toEqual([
      'event_log_default',
      'event_log_p202603',
    ]);
    const kept = await sql<{ n: bigint }>`SELECT count(*) AS n FROM app.event_log`.execute(app);
    expect(kept.rows[0]?.n).toBe(1n);
    expect(await dropped(maint, 'event_log', '2027-04-17T16:00:00.000Z')).toEqual([
      'event_log_p202603',
    ]);
    expect(await partitionNames(maint, 'event_log')).toEqual(['event_log_default']);
  });
});

it('[BR-ID-30 删除条件 created_at < 截止; contract A1 (ii)] created_at 比截止早 1 毫秒的行不挡删除：分区按上界与 created_at 都已过期即删', async () => {
  await withDatabase(async ({ maint, app }) => {
    await ensureMonths(maint, 'event_log', ['2026-03']);
    await sql`
      INSERT INTO app.event_log (app_id, event_id, name, payload, occurred_at, created_at)
      VALUES ('couli', '00000000-0000-7000-8000-00000000c0df'::uuid, 'order.created',
              '{"order_id": "late"}'::jsonb, '2026-03-31T12:00:00Z'::timestamptz,
              '2026-10-08T15:59:59.999Z'::timestamptz)
    `.execute(app);
    expect(await dropped(maint, 'event_log', '2027-04-16T16:00:00.000Z')).toEqual([
      'event_log_p202603',
    ]);
  });
});
