// B2-13a · BR-FUND-25 预估口径（BR-FUND-18 份额算法，BR-CALC-02 基数）：份额逐单逐角色向下取整后
// 再按期间合计；基数取有效联盟佣金（settle_commission_fen 非空取其值，否则 est_commission_fen）扣
// 15% 预留，B = floor(N × 8500 / 10000)；①② 只取本人 role=self / share 的份额；付款笔数与预估按
// paid_at 归期，不按归因时刻 attr_at。期望值在各用例里手写。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  TIMEOUT,
  column,
  invitee,
  order,
  referral,
  ruleVersion,
  summary,
  withDashboard,
  type OrderSpec,
  type Person,
} from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
let rules: string;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  rules = await ruleVersion(db);
}, 180_000);
afterAll(async () => {
  try {
    if (db !== undefined) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

function self(userId: string, ratioBp: number): Person[] {
  return [{ userId, role: 'self', ratioBp }];
}
function share(userId: string, ratioBp: number): Person[] {
  return [{ userId, role: 'share', ratioBp }];
}
/** 好友 buyer 的订单快照：buyer 自购 50%，本人为直推受益人。 */
function referred(buyer: string, me: string, ratioBp: number): Person[] {
  return [...self(buyer, 5000), { userId: me, role: 'direct', ratioBp }];
}

// 2026-11-12 10:00 +08:00；当天 09:00 付款。今日 11-12、昨日 11-11、本月 11 月、上月 10 月。
const NOV_12 = '2026-11-12T02:00:00.000Z';
const NOV_12_PAID = '2026-11-12T01:00:00.000Z';

it(
  '[AC-B2-13a#11] BR-FUND-25 / BR-FUND-18 预估逐单逐角色向下取整后再合计：有余数的份额不四舍五入、不在期间合计后才取整',
  async () => {
    await withDashboard(db, NOV_12, async (d) => {
      const me = d.me.uid;
      const today = (people: Person[], spec: Partial<OrderSpec> = {}) =>
        order(db, rules, { buyer: people[0]!.userId, paidAt: NOV_12_PAID, people, ...spec });
      // 自购：850 × 100 / 10000 = 8.5 → 8，两单 16；850 × 700 / 10000 = 59.5 → 59。
      // 合计 75（逐单四舍五入为 9 + 9 + 60 = 78；期间 900 bp 合计后取整为 76）。
      await today(self(me, 100));
      await today(self(me, 100));
      await today(self(me, 700), { platformStatus: 'RECEIVED', rebateStatus: 'WAITING' });
      // 分享：850 × 300 / 10000 = 25.5 → 25，两单 50（四舍五入 52；合计后取整 51）。
      await today(share(me, 300), { buyType: 'share' });
      await today(share(me, 300), {
        buyType: 'share',
        platformStatus: 'RECEIVED',
        rebateStatus: 'WAITING',
      });
      // 邀请：直推 100 bp 两单各 8 → 16；间推 300 bp 一单 25 → 本月 41（四舍五入 44；合计后取整 42）。
      const friend = await invitee(db, me);
      const grand = await invitee(db, friend);
      await today(referred(friend, me, 100));
      await today(referred(friend, me, 100));
      await today([
        ...self(grand, 5000),
        { userId: friend, role: 'direct', ratioBp: 1000 },
        { userId: me, role: 'indirect', ratioBp: 300 },
      ]);

      const data = await summary(await d.get());
      expect(data).toEqual({
        as_of: data.as_of,
        self: column({ today: [3, 75, 0], this_month: [3, 75, 0] }),
        share: column({ today: [2, 50, 0], this_month: [2, 50, 0] }),
        referral: referral([41, 0]),
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-13a#12] BR-FUND-25 找回后归因（attr_at 晚于 paid_at、落在另一期间）的订单按 paid_at 归期，不按 attr_at',
  async () => {
    await withDashboard(db, NOV_12, async (d) => {
      const me = d.me.uid;
      const recovered = (
        people: Person[],
        paidAt: string,
        attrAt: string,
        spec: Partial<OrderSpec> = {},
      ) =>
        order(db, rules, {
          buyer: people[0]!.userId,
          paidAt,
          people,
          ...spec,
          extra: { attr_at: new Date(attrAt), user_basis: 'claim' },
        });
      // 10-31 23:00 +08:00 付款、11-12 09:30 找回归因 → 上月 17。
      await recovered(self(me, 200), '2026-10-31T15:00:00.000Z', '2026-11-12T01:30:00.000Z');
      // 11-11 23:30 付款、11-12 00:10 找回归因 → 昨日、本月 34。
      await recovered(self(me, 400), '2026-11-11T15:30:00.000Z', '2026-11-11T16:10:00.000Z');
      // 分享单 10-15 付款、11-12 找回归因 → 上月 68。
      await recovered(share(me, 800), '2026-10-15T02:00:00.000Z', '2026-11-12T01:40:00.000Z', {
        buyType: 'share',
      });
      // 好友的订单：10-20 付款、11-12 找回归因 → 邀请上月 85；11-03 付款、11-12 归因 → 本月 17。
      const friend = await invitee(db, me);
      await recovered(
        referred(friend, me, 1000),
        '2026-10-20T02:00:00.000Z',
        '2026-11-12T01:50:00.000Z',
      );
      await recovered(
        referred(friend, me, 200),
        '2026-11-03T02:00:00.000Z',
        '2026-11-12T01:50:00.000Z',
      );

      const data = await summary(await d.get());
      expect(data).toEqual({
        as_of: data.as_of,
        self: column({
          yesterday: [1, 34, 0],
          this_month: [1, 34, 0],
          last_month: [1, 17, 0],
        }),
        share: column({ last_month: [1, 68, 0] }),
        referral: referral([17, 0], [85, 0]),
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-13a#13] BR-FUND-25 自购、分享栏只取本人 role=self / share 的份额：同单另有直推受益人时不计入整单用户份额合计；该份额进上级的邀请栏',
  async () => {
    await withDashboard(db, NOV_12, async (d) => {
      const me = d.me.uid;
      const parent = d.someone.uid;
      await db
        .withSchema('app')
        .updateTable('users')
        .set({ parent_id: parent, parent_bound_at: new Date('2026-06-01T00:00:00.000Z') })
        .where('id', '=', me)
        .execute();
      const direct: Person = { userId: parent, role: 'direct', ratioBp: 1000 };
      // 本人自购 5000 bp + 上级直推 1000 bp：本人 425（整单用户份额 510）。
      await order(db, rules, {
        buyer: me,
        paidAt: NOV_12_PAID,
        people: [...self(me, 5000), direct],
      });
      // 本人分享 4000 bp + 上级直推 1000 bp：本人 340（整单 425）。
      await order(db, rules, {
        buyer: me,
        buyType: 'share',
        paidAt: NOV_12_PAID,
        people: [...share(me, 4000), direct],
        platformStatus: 'RECEIVED',
        rebateStatus: 'WAITING',
      });

      const mine = await summary(await d.get());
      expect(mine).toEqual({
        as_of: mine.as_of,
        self: column({ today: [1, 425, 0], this_month: [1, 425, 0] }),
        share: column({ today: [1, 340, 0], this_month: [1, 340, 0] }),
        referral: referral(),
      });
      // 上级：两单各直推 85，只进邀请栏；不是归属用户，自购、分享栏为 0。
      const theirs = await summary(await d.get('', d.someone));
      expect(theirs).toEqual({
        as_of: theirs.as_of,
        self: column(),
        share: column(),
        referral: referral([170, 0]),
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-13a#14] BR-FUND-25 / BR-CALC-02 预估基数取有效联盟佣金：settle_commission_fen 非空时用结算佣金而非预估佣金或下单时的快照金额',
  async () => {
    await withDashboard(db, NOV_12, async (d) => {
      const me = d.me.uid;
      const today = (people: Person[], spec: Partial<OrderSpec>) =>
        order(db, rules, { buyer: people[0]!.userId, paidAt: NOV_12_PAID, people, ...spec });
      const unionSettled = (est: bigint, settle: bigint) => ({
        platformStatus: 'SETTLED' as const,
        rebateStatus: 'WAITING' as const,
        extra: {
          est_commission_fen: est,
          settle_commission_fen: settle,
          union_settled_at: new Date(NOV_12_PAID),
        },
      });
      // 联盟已结算、月结待入账：结算佣金 2000 → B = 1700，2000 bp → 340（按预估佣金为 170）。
      await today(self(me, 2000), unionSettled(1000n, 2000n));
      // 已付款单已有结算佣金 1100 → B = 935，1000 bp → 93.5 → 93（按预估佣金为 85）。
      await today(self(me, 1000), {
        platformStatus: 'RECEIVED',
        rebateStatus: 'ESTIMATED',
        extra: { est_commission_fen: 1000n, settle_commission_fen: 1100n },
      });
      // 分享：结算佣金 600 低于预估 → B = 510，4000 bp → 204（按预估佣金为 340）。
      await today(share(me, 4000), { buyType: 'share', ...unionSettled(1000n, 600n) });
      // 邀请：直推 1000 bp，结算佣金 2000 → 170；间推 400 bp，结算佣金 3000 → B = 2550 → 102。
      const friend = await invitee(db, me);
      const grand = await invitee(db, friend);
      await today(referred(friend, me, 1000), unionSettled(1000n, 2000n));
      await today(
        [
          ...self(grand, 5000),
          { userId: friend, role: 'direct', ratioBp: 1000 },
          { userId: me, role: 'indirect', ratioBp: 400 },
        ],
        unionSettled(1000n, 3000n),
      );

      const data = await summary(await d.get());
      expect(data).toEqual({
        as_of: data.as_of,
        self: column({ today: [2, 433, 0], this_month: [2, 433, 0] }),
        share: column({ today: [1, 204, 0], this_month: [1, 204, 0] }),
        referral: referral([272, 0]),
      });
    });
  },
  TIMEOUT,
);
