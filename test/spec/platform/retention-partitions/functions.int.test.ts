// B1-15zc — app.drop_expired_union_raw_payload_partitions 的规则（BR-ID-30 正文、⑦）。契约见 ./kit.ts 文件头。
// 每个用例先要求函数已存在：「不丢」与「既有规则不变」在骨架上本来就成立，否则红不起来。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import { DROPPABLE_TABLES } from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import {
  dropExpired,
  dropped,
  ensureMonths,
  monthRange,
  names,
  outcome,
  partitionNames,
  sqlState,
} from '../../db/partitions/kit.ts';
import { MONTH_TABLES } from '../maintenance/kit.ts';
import { inWorld, shift, type World } from '../retention/kit.ts';
import {
  CUTOFF,
  dropExpiredRaw,
  EXPIRED_MONTHS,
  FAR,
  holdRawRead,
  LONGER_DAYS,
  monthPartition,
  NEXT_DAY,
  NOW,
  OLD_MONTHS,
  rawRows,
  requireFunction,
  rowsOf,
  seedOldMonths,
  seedRaw,
  SIGNATURE,
  TABLE,
} from './kit.ts';

async function withWorld(scenario: (world: World) => Promise<void>): Promise<void> {
  await inWorld(await createTestDatabase(), scenario);
}

const ZONES = ['UTC', 'Pacific/Kiritimati', 'America/New_York'];

async function inZone(db: Kysely<DB>, zone: string, now: string, days: number): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('TimeZone', ${zone}, true)`.execute(trx);
    return dropExpiredRaw(trx, now, days);
  });
}

/**
 * 手算的月界：last 这一刻 months[1] 的上界还晚于截断点（+08:00 的月 1 日 00:00 早于 UTC 的月 1 日 00:00），
 * first（+08:00 下一日 00:00）截断点进到月 2 日 00:00，上界已过。
 */
const EDGES = [
  // 2026-09-28 − 180 天 = 2026-04-01；2026-09-29 → 2026-04-02。
  {
    months: ['2026-02', '2026-03', '2026-04'],
    last: '2026-09-28T15:59:59.999Z',
    first: '2026-09-28T16:00:00.000Z',
  },
  // 2026-06-30 − 180 天 = 2026-01-01；2026-07-01 → 2026-01-02：跨年。
  {
    months: ['2025-11', '2025-12', '2026-01'],
    last: '2026-06-30T15:59:59.999Z',
    first: '2026-06-30T16:00:00.000Z',
  },
  // 2028-07-30 − 180 天 = 2028-02-01；2028-07-31 → 2028-02-02：减去闰年的 2 月 29 日。
  {
    months: ['2027-12', '2028-01', '2028-02'],
    last: '2028-07-30T15:59:59.999Z',
    first: '2028-07-30T16:00:00.000Z',
  },
] as const;

it.each(ZONES)(
  '[AC-B1-15zc#1] 会话时区 %s：整个月都早于「运行当日 00:00（+08:00）− 180 天」才丢，跨月、跨年、跨闰年的日界前一毫秒留、恰到日界丢，后一个月不动',
  async (zone) => {
    await withWorld(async ({ maint }) => {
      await requireFunction(maint);
      for (const { months, last, first } of EDGES) {
        const [older, edge, newer] = months;
        await ensureMonths(maint, TABLE, months);
        expect(await inZone(maint, zone, last, 180), last).toEqual([monthPartition(older)]);
        expect(await inZone(maint, zone, first, 180), first).toEqual([monthPartition(edge)]);
        expect(await inZone(maint, zone, first, 180), first).toEqual([]);
        expect(await partitionNames(maint, TABLE)).toEqual([
          `${TABLE}_default`,
          monthPartition(newer),
        ]);
        expect(await dropExpiredRaw(maint, FAR, 180)).toEqual([monthPartition(newer)]);
      }
    });
  },
  60_000,
);

it('[AC-B1-15zc#2] p_days 决定截断点：220 天只丢 p202604，180 天再丢 p202605；次日 181 天留 p202606，180 天才丢', async () => {
  await withWorld(async ({ maint }) => {
    await requireFunction(maint);
    await ensureMonths(maint, TABLE, OLD_MONTHS);
    expect(await dropExpiredRaw(maint, NOW, LONGER_DAYS)).toEqual([monthPartition('2026-04')]);
    expect(await dropExpiredRaw(maint, NOW, 180)).toEqual([monthPartition('2026-05')]);
    expect(await dropExpiredRaw(maint, NEXT_DAY, 181)).toEqual([]);
    expect(await dropExpiredRaw(maint, NEXT_DAY, 180)).toEqual([monthPartition('2026-06')]);
  });
}, 60_000);

it('[AC-B1-15zc#3] 只丢整月都过期的分区：月末最后一刻的行随 p202605 丢；p202606 上界未到，全是更早的行也留，再有恰在截断点的行同样整月留；次日整月丢', async () => {
  await withWorld(async ({ app, maint }) => {
    await requireFunction(maint);
    await ensureMonths(maint, TABLE, ['2026-05', '2026-06']);
    const part = `app.${monthPartition('2026-06')}`;
    const firstOfJune = { part, at: '2026-06-01T00:00:00.000Z' };
    const justExpired = { part, at: shift(CUTOFF, -1) };
    const atCutoff = { part, at: CUTOFF };
    await seedRaw(app, '2026-05-31T23:59:59.999Z');
    await seedRaw(app, firstOfJune.at);
    await seedRaw(app, justExpired.at);

    expect(await dropExpiredRaw(maint, NOW, 180)).toEqual([monthPartition('2026-05')]);
    expect(await rawRows(app)).toEqual([firstOfJune, justExpired]);

    await seedRaw(app, atCutoff.at);
    expect(await dropExpiredRaw(maint, NOW, 180)).toEqual([]);
    expect(await rawRows(app)).toEqual([firstOfJune, justExpired, atCutoff]);

    await seedRaw(app, '2026-06-30T23:59:59.999Z');
    expect(await dropExpiredRaw(maint, NEXT_DAY, 180)).toEqual([monthPartition('2026-06')]);
    expect(await rawRows(app)).toEqual([]);
  });
}, 60_000);

it('[AC-B1-15zc#4] DEFAULT 分区不丢：很远的 p_now 按升序丢掉本表全部月分区，重复调用与只剩 DEFAULT 时都返回空数组，DEFAULT 的旧行还在；其他月分区表一个分区不少', async () => {
  await withWorld(async ({ app, maint }) => {
    await requireFunction(maint);
    expect(await dropExpiredRaw(maint, FAR, 180)).toEqual([]);
    const months = monthRange('2025-12', '2026-03');
    for (const table of MONTH_TABLES) await ensureMonths(maint, table, months);
    const fallback = `app.${TABLE}_default`;
    const defaultRows = [
      { part: fallback, at: '2020-06-15T00:00:00.000Z' },
      { part: fallback, at: '2031-05-05T05:05:05.000Z' },
    ];
    for (const row of defaultRows) await seedRaw(app, row.at);
    await seedRaw(app, '2026-01-15T00:00:00.000Z');

    expect(await dropExpiredRaw(maint, FAR, 180)).toEqual(names(TABLE, months));
    expect(await dropExpiredRaw(maint, FAR, 180)).toEqual([]);
    expect(await partitionNames(maint, TABLE)).toEqual([`${TABLE}_default`]);
    expect(await rawRows(app)).toEqual(defaultRows);
    for (const table of MONTH_TABLES.filter((name) => name !== TABLE)) {
      expect(await partitionNames(maint, table), table).toEqual(
        expect.arrayContaining(names(table, months)),
      );
    }
  });
}, 60_000);

it('[AC-B1-15zc#5] 按 fetched_at 判定，不看 created_at：created_at 很新的旧月分区照丢，created_at 很旧的未过期分区照留', async () => {
  await withWorld(async ({ app, maint }) => {
    await requireFunction(maint);
    await ensureMonths(maint, TABLE, ['2026-05', '2026-06']);
    await seedRaw(app, '2026-05-15T00:00:00.000Z', shift(NOW, -1));
    await seedRaw(app, '2026-06-15T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    expect(await dropExpiredRaw(maint, NOW, 180)).toEqual([monthPartition('2026-05')]);
    expect(await rawRows(app)).toEqual(rowsOf(['2026-06']));
  });
}, 60_000);

const ACL = ['couli_maint=X/couli_migrator', 'couli_migrator=X/couli_migrator'];

/** 账务、订单、审计、提现类表（⑧⑫⑰）与别的分区表，函数正文都不得引用。 */
const OFF_LIMITS =
  /\bapp\.(orders\b|order_|ledger_|withdrawals|withdraw_|payout_|settle_|commission_|claims|claim_items|audit_logs|event_log|link_logs|price_snapshot)/;

it('[AC-B1-15zc#6] SECURITY DEFINER 函数：一个重载、只授 couli_maint、PUBLIC 无权；直接删行与 DROP TABLE 仍被拒，只增触发器还在，正文不碰别的表', async () => {
  await withWorld(async ({ app, maint, payout, readonly }) => {
    await requireFunction(maint);
    await ensureMonths(maint, TABLE, ['2020-01']);
    await seedRaw(app, '2020-01-15T00:00:00.000Z');
    const definition = await sql<{
      owner: string;
      security_definer: boolean;
      returns: string;
      settings: string[];
      acl: string[];
      source: string;
    }>`
      SELECT pg_get_userbyid(proowner)::text AS owner, prosecdef AS security_definer,
        prorettype::regtype::text AS returns, proconfig AS settings, proacl::text[] AS acl,
        prosrc AS source
      FROM pg_proc
      WHERE oid = to_regprocedure(${SIGNATURE})
    `.execute(app);
    const row = definition.rows[0];
    expect(row).toMatchObject({
      owner: 'couli_migrator',
      security_definer: true,
      returns: 'text[]',
    });
    expect(row?.settings).toEqual(
      expect.arrayContaining(['search_path=pg_catalog, pg_temp', 'lock_timeout=5s']),
    );
    expect([...(row?.acl ?? [])].sort()).toEqual(ACL);
    const code = (row?.source ?? '').replace(/--[^\n]*/g, '');
    expect(code).toContain('union_raw_payloads');
    expect(code).not.toMatch(OFF_LIMITS);

    const overloads = await sql<{ n: bigint }>`
      SELECT count(*) AS n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = 'drop_expired_union_raw_payload_partitions'
    `.execute(app);
    expect(overloads.rows).toEqual([{ n: 1n }]);

    for (const role of [app, payout, readonly]) {
      expect(await sqlState(dropExpiredRaw(role, FAR, 180))).toBe('42501');
    }
    const partition = sql.table(`app.${monthPartition('2020-01')}`);
    for (const role of [maint, app, payout, readonly]) {
      expect(await sqlState(sql`DELETE FROM app.union_raw_payloads`.execute(role))).toBe('42501');
      expect(await sqlState(sql`DROP TABLE ${partition}`.execute(role))).toBe('42501');
    }
    expect(await rawRows(app)).toEqual(rowsOf(['2020-01']));
    const trigger = await sql<{ name: string }>`
      SELECT tgname::text AS name
      FROM pg_trigger
      WHERE tgrelid = to_regclass('app.union_raw_payloads') AND NOT tgisinternal
    `.execute(app);
    expect(trigger.rows).toEqual([{ name: 'union_raw_payloads_append_only' }]);

    expect(await dropExpiredRaw(maint, FAR, 180)).toEqual([monthPartition('2020-01')]);
  });
}, 60_000);

it('[AC-B1-15zc#7] p_now、p_days 为空或越界报错且什么都不丢，p_days 低于 180 拒绝；180 与 36500 可用', async () => {
  await withWorld(async ({ maint }) => {
    await requireFunction(maint);
    await ensureMonths(maint, TABLE, ['2020-01']);
    const inputs: Array<[string | null, number | null, string]> = [
      [null, 180, '22004'],
      [FAR, null, '22004'],
      [null, null, '22004'],
      ['infinity', 180, '22023'],
      ['-infinity', 180, '22023'],
      [FAR, 179, '22023'],
      [FAR, 30, '22023'],
      [FAR, 0, '22023'],
      [FAR, -1, '22023'],
      [FAR, 36501, '22023'],
      [FAR, 2147483647, '22023'],
    ];
    for (const [now, days, code] of inputs) {
      expect(
        await sqlState(dropExpiredRaw(maint, now, days)),
        `${String(now)} ${String(days)}`,
      ).toBe(code);
    }
    expect(await partitionNames(maint, TABLE)).toEqual([
      `${TABLE}_default`,
      monthPartition('2020-01'),
    ]);
    expect(await dropExpiredRaw(maint, FAR, 36500)).toEqual([]);
    expect(await dropExpiredRaw(maint, FAR, 180)).toEqual([monthPartition('2020-01')]);
  });
}, 60_000);

it('[AC-B1-15zc#8] 六个会话同时丢 24 个过期分区：全部成功，每个分区正好被丢、被报告一次，最后只剩 DEFAULT', async () => {
  await withWorld(async ({ maint, database }) => {
    await requireFunction(maint);
    const months = monthRange('2023-01', '2024-12');
    await ensureMonths(maint, TABLE, months);
    const sessions = Array.from({ length: 6 }, () =>
      createDb({ connectionString: database.urlFor('couli_maint'), max: 1 }),
    );
    try {
      const results = await Promise.all(
        sessions.map(async (db) => {
          try {
            return await dropExpiredRaw(db, FAR, 180);
          } catch (error) {
            return `failed: ${String((error as { code?: unknown }).code)}`;
          }
        }),
      );
      expect(results.filter((result) => typeof result === 'string')).toEqual([]);
      const reported = results.flatMap((result) => (typeof result === 'string' ? [] : result));
      expect(reported.sort()).toEqual(names(TABLE, months));
    } finally {
      await Promise.all(sessions.map((db) => destroyDb(db)));
    }
    expect(await partitionNames(maint, TABLE)).toEqual([`${TABLE}_default`]);
  });
}, 60_000);

it('[AC-B1-15zc#9] 有要丢的分区时等不到锁：lock_timeout 到点 55P03，整条语句回滚，一个分区都没丢；锁放开后全部丢掉', async () => {
  await withWorld(async ({ app, maint, database }) => {
    await requireFunction(maint);
    await seedOldMonths({ app, maint });
    const lock = holdRawRead(database);
    try {
      await lock.ready;
      expect(await sqlState(dropExpiredRaw(maint, NOW, 180))).toBe('55P03');
    } finally {
      lock.release();
      await lock.done;
    }
    expect(await partitionNames(maint, TABLE)).toEqual([
      `${TABLE}_default`,
      ...names(TABLE, OLD_MONTHS),
    ]);
    expect(await dropExpiredRaw(maint, NOW, 180)).toEqual(names(TABLE, EXPIRED_MONTHS));
  });
}, 60_000);

it('[AC-B1-15zc#10] 没有要丢的分区时不申请表锁：读事务持锁期间立刻返回空数组（04:00 后每小时一轮，不排在写入前面等锁）', async () => {
  await withWorld(async ({ app, maint, database }) => {
    await requireFunction(maint);
    await ensureMonths(maint, TABLE, ['2026-06']);
    await seedRaw(app, '2026-06-15T00:00:00.000Z');
    const lock = holdRawRead(database);
    try {
      await lock.ready;
      expect(await dropExpiredRaw(maint, NOW, 180)).toEqual([]);
    } finally {
      lock.release();
      await lock.done;
    }
  });
}, 60_000);

/** BR-ID-30 ⑧⑫⑰：保管期限确认前不删分区。 */
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

const NO_RULE = ['union_raw_payloads', 'link_logs', 'price_snapshot', 'no_such_table', ''];

it('[AC-B1-15zc#11] 既有规则不变：event_log 仍按 190 天丢，DROPPABLE_TABLES 仍是 [event_log]；通用函数对 RETAINED 表 55000、对本表与其他未列表 22023，什么都不丢', async () => {
  await withWorld(async ({ maint }) => {
    await requireFunction(maint);
    expect([...DROPPABLE_TABLES]).toEqual(['event_log']);
    await ensureMonths(maint, 'event_log', monthRange('2026-02', '2026-04'));
    await ensureMonths(maint, 'orders', ['2020-01']);
    await ensureMonths(maint, TABLE, ['2020-01']);
    // 2026-10-08 − 190 天 = 2026-04-01；2026-10-09 → 2026-04-02。
    expect(await dropped(maint, 'event_log', '2026-10-08T15:59:59.999Z')).toEqual([
      'event_log_p202602',
    ]);
    expect(await dropped(maint, 'event_log', '2026-10-08T16:00:00.000Z')).toEqual([
      'event_log_p202603',
    ]);

    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const table of RETAINED) {
      got[table] = await outcome(dropExpired(maint, table, FAR));
      want[table] =
        `55000 drop_expired_month_partitions: partitions of app.${table} are kept until their retention period is confirmed`;
    }
    for (const table of NO_RULE) {
      got[table] = await outcome(dropExpired(maint, table, FAR));
      want[table] =
        `22023 drop_expired_month_partitions: table "${table}" has no partition retention rule`;
    }
    expect(got).toEqual(want);
    expect(await partitionNames(maint, 'orders')).toEqual(['orders_default', 'orders_p202001']);
    expect(await partitionNames(maint, TABLE)).toEqual([
      `${TABLE}_default`,
      monthPartition('2020-01'),
    ]);
  });
}, 60_000);
