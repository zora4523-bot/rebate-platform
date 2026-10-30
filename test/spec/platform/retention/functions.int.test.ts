// B1-15zb — 每表一个清理函数的规则（BR-ID-30 正文、⑥⑩⑮⑯⑱）。契约见 ./kit.ts 文件头。
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { sqlState } from '../../db/partitions/kit.ts';
import {
  boundary,
  CREATED_AT_TABLES,
  CUTOFF,
  DAY_MS,
  deleteAny,
  deleteBatch,
  deleteIdentities,
  holdLock,
  HOUR_MS,
  inWorld,
  lockRow,
  NOW,
  PURGED_TABLES,
  requireFunctions,
  RETAINED_DAYS,
  seedIdentity,
  seedRow,
  shift,
  signature,
  times,
  type World,
} from './kit.ts';

async function withWorld(scenario: (world: World) => Promise<void>): Promise<void> {
  await inWorld(await createTestDatabase(), scenario);
}

const ZONES = ['UTC', 'Pacific/Kiritimati', 'America/New_York'];

/** 手算的截断点：p_now 的 +08:00 日历日 − 180 / 190 天，取该日 00:00（+08:00）。 */
const CASES: readonly ({ readonly now: string } & Readonly<Record<180 | 190, string>>)[] = [
  // 2026-11-20 04:00 → 2026-05-24、2026-05-14：跨月。
  {
    now: NOW,
    180: CUTOFF[180],
    190: CUTOFF[190],
  },
  // 2027-03-29 04:00 → 2026-09-30、2026-09-20：跨年，BR-ID-30 细则的 login_logs 例。
  {
    now: '2027-03-28T20:00:00.000Z',
    180: '2026-09-29T16:00:00.000Z',
    190: '2026-09-19T16:00:00.000Z',
  },
  // 2026-12-31 23:59:59.999 → 2026-07-04、2026-06-24：日界前一毫秒还算当日。
  {
    now: '2026-12-31T15:59:59.999Z',
    180: '2026-07-03T16:00:00.000Z',
    190: '2026-06-23T16:00:00.000Z',
  },
  // 2027-01-01 00:00 → 2026-07-05、2026-06-25：日界恰到就算下一日。
  {
    now: '2026-12-31T16:00:00.000Z',
    180: '2026-07-04T16:00:00.000Z',
    190: '2026-06-24T16:00:00.000Z',
  },
  // 2028-03-01 00:00 → 2027-09-03、2027-08-24：减去闰年的 2 月 29 日。
  {
    now: '2028-02-29T16:00:00.000Z',
    180: '2027-09-02T16:00:00.000Z',
    190: '2027-08-23T16:00:00.000Z',
  },
];

const LATER_THAN_EVERY_CASE = '2035-01-01T00:00:00.000Z';

/** NOW 减 200 天：2026-05-04 00:00（+08:00）。 */
const CUTOFF_200 = '2026-05-03T16:00:00.000Z';

it.each(CREATED_AT_TABLES)(
  '[AC-B1-15zb#1] %s：恰等于截断点保留，早一毫秒删；按 +08:00 日历天相减，跨月跨年跨闰年，不看会话时区',
  async (table) => {
    await withWorld(async ({ app, maint }) => {
      await requireFunctions(maint);
      const days = RETAINED_DAYS[table];
      for (const zone of ZONES) {
        for (const entry of CASES) {
          const cutoff = entry[days];
          await seedRow(app, table, shift(cutoff, -1));
          await seedRow(app, table, cutoff);
          await seedRow(app, table, shift(cutoff, 1));
          await maint.transaction().execute(async (trx) => {
            await sql`SELECT set_config('TimeZone', ${zone}, true)`.execute(trx);
            expect(await deleteBatch(trx, table, entry.now, days, 1000)).toBe(1n);
            expect(await deleteBatch(trx, table, entry.now, days, 1000)).toBe(0n);
          });
          expect(await times(app, table)).toEqual([cutoff, shift(cutoff, 1)]);
          expect(await deleteBatch(maint, table, LATER_THAN_EVERY_CASE, days, 1000)).toBe(2n);
        }
      }
      // p_days 决定截断点，不是写死 08 现值。
      await seedRow(app, table, shift(CUTOFF_200, -1));
      await seedRow(app, table, CUTOFF_200);
      expect(await deleteBatch(maint, table, NOW, 200, 1000)).toBe(1n);
      expect(await times(app, table)).toEqual([CUTOFF_200]);
    });
  },
  60_000,
);

it('[AC-B1-15zb#2] deleted_identities：expire_at 早于 p_now 才删，相等保留，不截到日界，不看 created_at（⑩）', async () => {
  await withWorld(async ({ app, maint }) => {
    await requireFunctions(maint);
    const justPast = shift(NOW, -1);
    const justAhead = shift(NOW, 1);
    await seedIdentity(app, justPast, { createdAt: NOW });
    await seedIdentity(app, NOW, { createdAt: '2020-01-01T00:00:00.000Z' });
    await seedIdentity(app, justAhead, { createdAt: '2020-01-01T00:00:00.000Z' });
    expect(await deleteIdentities(maint, NOW, 1000)).toBe(1n);
    expect(await deleteIdentities(maint, NOW, 1000)).toBe(0n);
    expect(await times(app, 'deleted_identities')).toEqual([NOW, justAhead]);
    expect(await deleteIdentities(maint, shift(NOW, 2), 1000)).toBe(2n);
    expect(await times(app, 'deleted_identities')).toEqual([]);
  });
}, 60_000);

const ACL = ['couli_maint=X/couli_migrator', 'couli_migrator=X/couli_migrator'];

/** 账务、订单、审计、提现类表（⑧⑫⑰）与本批不清的表，函数正文都不得引用。 */
const OFF_LIMITS =
  /\bapp\.(orders\b|order_|ledger_|withdrawals|withdraw_|payout_|settle_|commission_|claims|claim_items|audit_logs|blocklist)/;

it('[AC-B1-15zb#3] 每表一个 SECURITY DEFINER 函数：一个重载、只授 couli_maint、PUBLIC 无权，直接 DELETE 仍被拒，正文不碰 ⑧⑫⑰', async () => {
  await withWorld(async ({ app, maint, payout, readonly }) => {
    await requireFunctions(maint);
    for (const table of PURGED_TABLES) {
      await seedRow(app, table, shift(boundary(table), -1));
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
        WHERE oid = to_regprocedure(${signature(table)})
      `.execute(app);
      const row = definition.rows[0];
      expect(row, table).toMatchObject({
        owner: 'couli_migrator',
        security_definer: true,
        returns: 'bigint',
      });
      expect(row?.settings, table).toEqual(
        expect.arrayContaining(['search_path=pg_catalog, pg_temp', 'lock_timeout=5s']),
      );
      expect([...(row?.acl ?? [])].sort(), table).toEqual(ACL);
      const code = (row?.source ?? '').replace(/--[^\n]*/g, '');
      expect(code, table).toContain(`app.${table}`);
      expect(code, table).not.toMatch(OFF_LIMITS);

      const overloads = await sql<{ n: bigint }>`
        SELECT count(*) AS n
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname = ${`delete_expired_${table}`}
      `.execute(app);
      expect(overloads.rows, table).toEqual([{ n: 1n }]);

      for (const role of [app, payout, readonly]) {
        expect(await sqlState(deleteAny(role, table, NOW, 1000)), table).toBe('42501');
      }
      // deleted_identities 的 DELETE 是 couli_app 既有权限（注销流程用），本任务不动它。
      const denied = table === 'deleted_identities' ? [maint] : [maint, app];
      for (const role of [...denied, payout, readonly]) {
        expect(
          await sqlState(sql`DELETE FROM ${sql.table(`app.${table}`)}`.execute(role)),
          table,
        ).toBe('42501');
      }
      expect(await deleteAny(maint, table, NOW, 1000), table).toBe(1n);
    }
  });
}, 60_000);

it.each(CREATED_AT_TABLES)(
  '[AC-B1-15zb#4] %s：p_now、p_days、p_batch_size 为空或越界报错且不删，p_days 低于表下限报错；边界值可用',
  async (table) => {
    await withWorld(async ({ app, maint }) => {
      await requireFunctions(maint);
      const days = RETAINED_DAYS[table];
      const expired = shift(CUTOFF[days], -1);
      await seedRow(app, table, expired);
      const inputs: Array<[string | null, number | null, number | null, string]> = [
        [null, days, 1, '22004'],
        [NOW, null, 1, '22004'],
        [NOW, days, null, '22004'],
        ['infinity', days, 1, '22023'],
        ['-infinity', days, 1, '22023'],
        [NOW, days - 1, 1, '22023'],
        [NOW, 30, 1, '22023'],
        [NOW, 0, 1, '22023'],
        [NOW, -1, 1, '22023'],
        [NOW, 36501, 1, '22023'],
        [NOW, 2147483647, 1, '22023'],
        [NOW, days, 0, '22023'],
        [NOW, days, -1, '22023'],
        [NOW, days, 10001, '22023'],
      ];
      for (const [now, inputDays, size, code] of inputs) {
        expect(
          await sqlState(deleteBatch(maint, table, now, inputDays, size)),
          `${String(now)} ${String(inputDays)} ${String(size)}`,
        ).toBe(code);
      }
      expect(await times(app, table)).toEqual([expired]);
      expect(await deleteBatch(maint, table, NOW, days, 1)).toBe(1n);
      await seedRow(app, table, expired);
      expect(await deleteBatch(maint, table, NOW, days, 10000)).toBe(1n);
      await seedRow(app, table, '1900-01-01T00:00:00.000Z');
      expect(await deleteBatch(maint, table, NOW, 36500, 10000)).toBe(1n);
      expect(await times(app, table)).toEqual([]);
    });
  },
  60_000,
);

it('[AC-B1-15zb#5] deleted_identities：p_now、p_batch_size 为空或越界报错且不删；批大小 1 与 10000 可用', async () => {
  await withWorld(async ({ app, maint }) => {
    await requireFunctions(maint);
    const expired = shift(NOW, -1);
    await seedIdentity(app, expired);
    const inputs: Array<[string | null, number | null, string]> = [
      [null, 1, '22004'],
      [NOW, null, '22004'],
      ['infinity', 1, '22023'],
      ['-infinity', 1, '22023'],
      [NOW, 0, '22023'],
      [NOW, -1, '22023'],
      [NOW, 10001, '22023'],
    ];
    for (const [now, size, code] of inputs) {
      expect(
        await sqlState(deleteIdentities(maint, now, size)),
        `${String(now)} ${String(size)}`,
      ).toBe(code);
    }
    expect(await times(app, 'deleted_identities')).toEqual([expired]);
    expect(await deleteIdentities(maint, NOW, 1)).toBe(1n);
    await seedIdentity(app, expired);
    expect(await deleteIdentities(maint, NOW, 10000)).toBe(1n);
    expect(await times(app, 'deleted_identities')).toEqual([]);
  });
}, 60_000);

it.each(PURGED_TABLES)(
  '[AC-B1-15zb#6] %s：每次只删一批，从时间列最旧的开始，跨 app_id，不删未到期行',
  async (table) => {
    await withWorld(async ({ app, maint }) => {
      await requireFunctions(maint);
      const expired = [5, 4, 3, 2, 1].map((hours) => shift(boundary(table), -hours * HOUR_MS));
      for (const [index, at] of expired.entries()) {
        await seedRow(app, table, at, index % 2 === 0 ? 'other-app' : 'couli');
      }
      await seedRow(app, table, boundary(table));
      const counts: bigint[] = [];
      for (const left of [3, 1, 0, 0]) {
        counts.push(await deleteAny(maint, table, NOW, 2));
        expect(await times(app, table)).toEqual([
          ...expired.slice(expired.length - left),
          boundary(table),
        ]);
      }
      expect(counts).toEqual([2n, 2n, 1n, 0n]);
    });
  },
  60_000,
);

it.each(PURGED_TABLES)(
  '[AC-B1-15zb#7] %s：被并发写入锁住的行跳过（SKIP LOCKED），不等锁，下一批再删',
  async (table) => {
    await withWorld(async ({ app, maint, database }) => {
      await requireFunctions(maint);
      const oldest = shift(boundary(table), -3 * DAY_MS);
      await seedRow(app, table, oldest);
      await seedRow(app, table, shift(boundary(table), -2 * DAY_MS));
      await seedRow(app, table, shift(boundary(table), -DAY_MS));
      const lock = holdLock(database, (trx) => lockRow(trx, table, oldest));
      try {
        await lock.ready;
        expect(await deleteAny(maint, table, NOW, 1000)).toBe(2n);
      } finally {
        lock.release();
        await lock.done;
      }
      expect(await times(app, table)).toEqual([oldest]);
      expect(await deleteAny(maint, table, NOW, 1000)).toBe(1n);
      expect(await times(app, table)).toEqual([]);
    });
  },
  60_000,
);
