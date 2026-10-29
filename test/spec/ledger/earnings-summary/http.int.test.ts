// B2-13a · BR-FUND-25（BR-INV-16、17）：GET /v1/earnings/summary 经正式 api 入口与测试库读取，
// 时钟注入。各用例的期望笔数与金额手写：份额 = floor(850 × ratio_bp / 10000)（见 kit.ts），
// 已结算 = 本人 available 子户上该栏类型分录的 −Σ amount_fen，按 accounting_date 归期。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Account } from '../../db/ledger/invariants/kit.ts';
import {
  TIMEOUT,
  books,
  column,
  counterAccount,
  credit,
  creditedOrder,
  footprint,
  invitee,
  order,
  post,
  referral,
  refused,
  reverse,
  ruleVersion,
  summary,
  withDashboard,
  type CreditInput,
  type OrderExtra,
  type OrderSpec,
  type Person,
} from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
let rules: string;
let counter: Account;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  rules = await ruleVersion(db);
  counter = await counterAccount(db);
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
function referred(buyer: string, me: string, ratioBp: number, forfeited = false): Person[] {
  return [
    ...self(buyer, 5000),
    forfeited
      ? { userId: me, role: 'direct', ratioBp, initialStatus: 'forfeited' }
      : { userId: me, role: 'direct', ratioBp },
  ];
}

// 2026-11-01 00:30 +08:00：今日 11-01、昨日 10-31、本月 11 月、上月 10 月。
const NOV_FIRST = '2026-10-31T16:30:00.000Z';
// 2026-11-12 10:00 +08:00（BR-FUND-25 细则的例子时刻）；当天 09:00 付款。
const NOV_12 = '2026-11-12T02:00:00.000Z';
const NOV_12_PAID = '2026-11-12T01:00:00.000Z';

it(
  '[AC-B2-13a#1] BR-FUND-25 付款笔数与预估按 paid_at 归 +08:00 自然日与自然月：跨午夜、跨月末各归其期间',
  async () => {
    await withDashboard(db, NOV_FIRST, async (d) => {
      const me = d.me.uid;
      const paid = (paidAt: string, ratioBp: number) =>
        order(db, rules, { buyer: me, paidAt, people: self(me, ratioBp) });
      await paid('2026-10-31T16:00:00.000Z', 200); // 11-01 00:00:00.000 → 今日、本月 17
      await paid('2026-10-31T15:59:59.999Z', 400); // 10-31 23:59:59.999 → 昨日、上月 34
      await paid('2026-10-30T16:00:00.000Z', 800); // 10-31 00:00 → 昨日、上月 68
      await paid('2026-10-30T15:59:59.999Z', 1600); // 10-30 → 上月 136
      await paid('2026-09-30T16:00:00.000Z', 3200); // 10-01 00:00 → 上月 272
      await paid('2026-09-30T15:59:59.999Z', 6400); // 09-30 → 不在任何期间

      const data = await summary(await d.get());
      expect(Date.parse(data.as_of)).toBe(Date.parse(NOV_FIRST));
      expect(data).toEqual({
        as_of: data.as_of,
        self: column({
          today: [1, 17, 0],
          yesterday: [2, 102, 0],
          this_month: [1, 17, 0],
          last_month: [4, 510, 0],
        }),
        share: column(),
        referral: referral(),
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-13a#2] BR-FUND-25 跨年：as_of 恰为 2027-01-01 00:00 +08:00 时上月是 2026-12，付款时刻与会计日各按边界归期',
  async () => {
    const at = '2026-12-31T16:00:00.000Z';
    await withDashboard(db, at, async (d) => {
      const me = d.me.uid;
      const paid = (paidAt: string, ratioBp: number) =>
        order(db, rules, { buyer: me, paidAt, people: self(me, ratioBp) });
      await paid(at, 200); // 恰在 as_of → 今日、本月 17
      await paid('2026-12-31T15:59:59.999Z', 400); // 12-31 → 昨日、上月 34
      await paid('2026-11-30T16:00:00.000Z', 800); // 12-01 00:00 → 上月 68
      await paid('2026-11-30T15:59:59.999Z', 1600); // 11-30 → 不在任何期间
      const b = await books(db, me, counter);
      const credited = async (date: string, fen: bigint) => {
        const orderKey = await creditedOrder(db, rules, me, self(me, 5000));
        await credit(db, b, { orderKey, role: 'self', type: 'REBATE_CREDIT', fen }, date);
      };
      await credited('2027-01-01', 11n);
      await credited('2026-12-31', 22n);
      await credited('2026-12-01', 44n);
      await credited('2026-11-30', 88n);

      const data = await summary(await d.get());
      expect(Date.parse(data.as_of)).toBe(Date.parse(at));
      expect(data).toEqual({
        as_of: data.as_of,
        self: column({
          today: [1, 17, 11],
          yesterday: [1, 34, 22],
          this_month: [1, 17, 11],
          last_month: [2, 102, 66],
        }),
        share: column(),
        referral: referral(),
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-13a#3] BR-FUND-25 计入笔数：已归因本人、到过 PAID、ESTIMATED / WAITING / CREDITED；预估只合计 ESTIMATED / WAITING 的本人份额',
  async () => {
    await withDashboard(db, NOV_12, async (d) => {
      const me = d.me.uid;
      const mine = (
        ratioBp: number,
        platformStatus: NonNullable<OrderSpec['platformStatus']>,
        rebateStatus: NonNullable<OrderSpec['rebateStatus']>,
        extra: OrderExtra = {},
        paidAt = NOV_12_PAID,
      ) =>
        order(db, rules, {
          buyer: me,
          paidAt,
          people: self(me, ratioBp),
          platformStatus,
          rebateStatus,
          extra,
        });
      // 自购今日计入 4 笔，预估 17 + 34 = 51。
      await mine(200, 'PAID', 'ESTIMATED'); // 计入，17
      await mine(400, 'RECEIVED', 'WAITING'); // 计入，34
      await mine(800, 'SETTLED', 'CREDITED'); // 计入；已入账，不算预估
      await mine(5000, 'PAID', 'ESTIMATED', { est_commission_fen: 0n }); // 本单无返利：计入，0
      // 不计入：只付定金、已失效、已全额扣回。
      await mine(1600, 'DEPOSIT_PAID', 'ESTIMATED', {
        is_presale: true,
        deposit_paid_at: new Date(NOV_12_PAID),
      });
      await mine(3200, 'INVALID', 'VOID', { reason: 'REFUND' });
      await mine(6400, 'SETTLED', 'CLAWED_BACK', { reason: 'REFUND' });
      // 昨日付款、之后已退款失效（细则例）：昨日 0 笔。
      await mine(2000, 'INVALID', 'VOID', { reason: 'REFUND' }, '2026-11-11T01:00:00.000Z');
      // 本月更早：11-02 付款、已收货等待月结，85。
      await mine(1000, 'RECEIVED', 'WAITING', {}, '2026-11-02T02:00:00.000Z');
      // 未归因：快照里虽有本人，也不计。
      await order(db, rules, { buyer: null, paidAt: NOV_12_PAID, people: self(me, 1000) });
      // 分享栏：本人的分享单。
      const shared = (ratioBp: number, spec: Partial<OrderSpec>) =>
        order(db, rules, {
          buyer: me,
          buyType: 'share',
          paidAt: NOV_12_PAID,
          people: share(me, ratioBp),
          ...spec,
        });
      await shared(2000, { platformStatus: 'RECEIVED', rebateStatus: 'WAITING' }); // 今日 170
      await shared(4000, {
        platformStatus: 'INVALID',
        rebateStatus: 'VOID',
        extra: { reason: 'REFUND' },
      }); // 不计
      await shared(600, { paidAt: '2026-10-15T02:00:00.000Z' }); // 上月 51
      // 别人的自购单不进本人任何一栏。
      const other = d.someone.uid;
      await order(db, rules, { buyer: other, paidAt: NOV_12_PAID, people: self(other, 5000) });

      const data = await summary(await d.get());
      expect(data).toEqual({
        as_of: data.as_of,
        self: column({ today: [4, 51, 0], this_month: [5, 136, 0] }),
        share: column({ today: [1, 170, 0], this_month: [1, 170, 0], last_month: [1, 51, 0] }),
        referral: referral(),
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-13a#4] BR-FUND-25 已结算按会计日取 REBATE / SHARE / REFERRAL_CREDIT 的代数和：入账正、红冲负，只有红冲的期间为负；不含扣回、补差、调账、奖励与他人分录',
  async () => {
    await withDashboard(db, NOV_FIRST, async (d) => {
      const me = d.me.uid;
      const b = await books(db, me, counter);
      const rebate = async (fen: bigint): Promise<CreditInput> => ({
        orderKey: await creditedOrder(db, rules, me, self(me, 5000)),
        role: 'self',
        type: 'REBATE_CREDIT',
        fen,
      });
      // ① 自购 REBATE_CREDIT。
      await credit(db, b, await rebate(520n), '2026-11-01');
      // 会计日 10-31、记账时刻已是 11-01 00:10 +08:00：按会计日归昨日。
      await credit(db, b, await rebate(300n), '2026-10-31', '2026-10-31T16:10:00.000Z');
      await credit(db, b, await rebate(1000n), '2026-10-01');
      const corrected = await rebate(120n);
      await credit(db, b, corrected, '2026-10-15');
      await reverse(db, b, corrected, '2026-10-31'); // 红冲按自己的会计日归昨日，不回改 10-15
      await credit(db, b, await rebate(7000n), '2026-09-30');
      // 不计入：售后扣回、结算补差、人工调账、活动奖励。
      const clawed = (await rebate(1n)).orderKey;
      const excluded = [
        ['CLAWBACK', 'PART_REFUND', `${clawed}:${me}:self:CLAWBACK:${randomUUID()}`, 50n],
        ['SETTLE_ADJUST', 'SETTLE_DIFF', `${clawed}:${me}:self:ADJ:${randomUUID()}`, -40n],
        ['ADMIN_ADJUST', 'OTHER', `adjust:${randomUUID()}`, -30n],
        ['REWARD', 'invite', `reward:${randomUUID()}`, -20n],
      ] as const;
      for (const [type, subType, uniqKey, userFen] of excluded) {
        const onOrder = type === 'CLAWBACK' || type === 'SETTLE_ADJUST';
        await post(db, b, {
          uniqKey,
          orderKey: onOrder ? clawed : null,
          role: onOrder ? 'self' : null,
          kind: type,
          type,
          subType,
          date: type === 'SETTLE_ADJUST' ? '2026-10-31' : '2026-11-01',
          bookedAt: null,
          userFen,
        });
      }
      // ② 分享 SHARE_CREDIT：本月只有一张红冲 → 今日、本月 −260；上月保留入账 260。
      const shared: CreditInput = {
        orderKey: await creditedOrder(db, rules, me, share(me, 5000), 'taobao', 'share'),
        role: 'share',
        type: 'SHARE_CREDIT',
        fen: 260n,
      };
      await credit(db, b, shared, '2026-10-20');
      await reverse(db, b, shared, '2026-11-01');
      // ③ 邀请 REFERRAL_CREDIT：直推与间推合计。
      const friend = await invitee(db, me);
      const grand = await invitee(db, friend);
      const direct = async (fen: bigint): Promise<CreditInput> => ({
        orderKey: await creditedOrder(db, rules, friend, referred(friend, me, 1000)),
        role: 'direct',
        type: 'REFERRAL_CREDIT',
        subType: 'DIRECT',
        fen,
      });
      await credit(db, b, await direct(70n), '2026-11-01');
      const indirectKey = await creditedOrder(db, rules, grand, [
        ...self(grand, 5000),
        { userId: friend, role: 'direct', ratioBp: 1000 },
        { userId: me, role: 'indirect', ratioBp: 400 },
      ]);
      await credit(
        db,
        b,
        {
          orderKey: indirectKey,
          role: 'indirect',
          type: 'REFERRAL_CREDIT',
          subType: 'INDIRECT',
          fen: 15n,
        },
        '2026-10-20',
      );
      const fixedReferral = await direct(5n);
      await credit(db, b, fixedReferral, '2026-10-25');
      await reverse(db, b, fixedReferral, '2026-10-31');
      // 别人的入账不进本人。
      const other = d.someone.uid;
      await credit(
        db,
        await books(db, other, counter),
        {
          orderKey: await creditedOrder(db, rules, other, self(other, 5000)),
          role: 'self',
          type: 'REBATE_CREDIT',
          fen: 99_999n,
        },
        '2026-11-01',
      );

      const data = await summary(await d.get());
      expect(data).toEqual({
        as_of: data.as_of,
        self: column({
          today: [0, 0, 520],
          yesterday: [0, 0, 180],
          this_month: [0, 0, 520],
          last_month: [0, 0, 1300],
        }),
        share: column({
          today: [0, 0, -260],
          this_month: [0, 0, -260],
          last_month: [0, 0, 260],
        }),
        referral: referral([0, 70], [0, 15]),
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-13a#5] BR-FUND-25 / BR-INV-16、17 邀请栏只有本月、上月的预估与已结算合计（直推 + 间推、全部平台），没有笔数',
  async () => {
    await withDashboard(db, NOV_FIRST, async (d) => {
      const me = d.me.uid;
      const friend = await invitee(db, me);
      const grand = await invitee(db, friend);
      const theirs = (paidAt: string, people: Person[], spec: Partial<OrderSpec> = {}) =>
        order(db, rules, { buyer: people[0]!.userId, paidAt, people, ...spec });
      await theirs('2026-10-31T16:00:00.000Z', referred(friend, me, 1000)); // 本月 85
      await theirs(
        '2026-10-31T15:59:59.999Z',
        [
          ...self(grand, 5000),
          { userId: friend, role: 'direct', ratioBp: 1000 },
          { userId: me, role: 'indirect', ratioBp: 400 },
        ],
        { platformStatus: 'RECEIVED', rebateStatus: 'WAITING' },
      ); // 间推，上月 34
      await theirs('2026-10-12T02:00:00.000Z', referred(friend, me, 2000), { platform: 'jd' }); // 上月 170
      await theirs(
        '2026-10-31T16:10:00.000Z',
        [...share(friend, 5000), { userId: me, role: 'direct', ratioBp: 200 }],
        { buyType: 'share' },
      ); // 好友的分享单，本月 17
      // 不计入预估：失效、只付定金、已入账、不在两个期间、本人份额已被剥夺。
      const late = '2026-10-31T16:05:00.000Z';
      await theirs(late, referred(friend, me, 3200), {
        platformStatus: 'INVALID',
        rebateStatus: 'VOID',
        extra: { reason: 'REFUND' },
      });
      await theirs(late, referred(friend, me, 4400), {
        platformStatus: 'DEPOSIT_PAID',
        extra: { is_presale: true, deposit_paid_at: new Date(late) },
      });
      await theirs(late, referred(friend, me, 800), {
        platformStatus: 'SETTLED',
        rebateStatus: 'CREDITED',
      });
      await theirs('2026-09-30T15:59:59.999Z', referred(friend, me, 1600));
      await theirs(late, referred(friend, me, 1000, true));

      const data = await summary(await d.get());
      // 好友的订单不进本人的自购、分享栏。
      expect(data).toEqual({
        as_of: data.as_of,
        self: column(),
        share: column(),
        referral: referral([102, 0], [204, 0]),
      });
      expect(data.referral).not.toBeNull();
      expect(Object.keys(data.referral ?? {}).sort()).toEqual(['last_month', 'this_month']);
      for (const period of [data.referral?.this_month, data.referral?.last_month]) {
        expect(Object.keys(period ?? {}).sort()).toEqual(['credited_fen', 'est_fen']);
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-13a#6] BR-FUND-25 platform 只筛自购与分享的笔数、预估、已结算；邀请栏始终是全部平台合计；未知平台 20001',
  async () => {
    await withDashboard(db, NOV_12, async (d) => {
      const me = d.me.uid;
      const b = await books(db, me, counter);
      const paidToday = (people: Person[], spec: Partial<OrderSpec>) =>
        order(db, rules, { buyer: people[0]!.userId, paidAt: NOV_12_PAID, people, ...spec });
      await paidToday(self(me, 200), {}); // taobao 17
      await paidToday(self(me, 400), { platform: 'jd' }); // jd 34
      await paidToday(share(me, 800), {
        buyType: 'share',
        platform: 'pdd',
        platformStatus: 'RECEIVED',
        rebateStatus: 'WAITING',
      }); // pdd 68
      await paidToday(share(me, 1600), { buyType: 'share' }); // taobao 136
      const booked = async (
        people: Person[],
        platformCode: string,
        input: Omit<CreditInput, 'orderKey'>,
        date: string,
      ) => {
        const buyer = people[0]!.userId;
        const buyType = people[0]!.role === 'share' ? 'share' : 'self';
        const orderKey = await creditedOrder(db, rules, buyer, people, platformCode, buyType);
        await credit(db, b, { orderKey, ...input }, date);
      };
      const rebate = { role: 'self', type: 'REBATE_CREDIT' } as const;
      await booked(self(me, 5000), 'taobao', { ...rebate, fen: 100n }, '2026-11-05');
      await booked(self(me, 5000), 'jd', { ...rebate, fen: 200n }, '2026-11-06');
      const shareCredit = { role: 'share', type: 'SHARE_CREDIT', fen: 300n } as const;
      await booked(share(me, 5000), 'pdd', shareCredit, '2026-11-07');
      const friend = await invitee(db, me);
      await paidToday(referred(friend, me, 1000), {}); // taobao 85
      await order(db, rules, {
        buyer: friend,
        paidAt: '2026-11-03T02:00:00.000Z',
        people: referred(friend, me, 2000),
        platform: 'jd',
        platformStatus: 'RECEIVED',
        rebateStatus: 'WAITING',
      }); // jd 170
      const directCredit = { role: 'direct', type: 'REFERRAL_CREDIT', subType: 'DIRECT' } as const;
      const friendPeople = referred(friend, me, 1000);
      await booked(friendPeople, 'jd', { ...directCredit, fen: 40n }, '2026-11-08');
      await booked(friendPeople, 'pdd', { ...directCredit, fen: 60n }, '2026-10-10');
      const everyPlatform = referral([255, 40], [0, 60]);

      const all = await summary(await d.get());
      expect(all).toEqual({
        as_of: all.as_of,
        self: column({ today: [2, 51, 0], this_month: [2, 51, 300] }),
        share: column({ today: [2, 204, 0], this_month: [2, 204, 300] }),
        referral: everyPlatform,
      });
      const expected = {
        taobao: {
          self: column({ today: [1, 17, 0], this_month: [1, 17, 100] }),
          share: column({ today: [1, 136, 0], this_month: [1, 136, 0] }),
        },
        jd: {
          self: column({ today: [1, 34, 0], this_month: [1, 34, 200] }),
          share: column(),
        },
        pdd: {
          self: column(),
          share: column({ today: [1, 68, 0], this_month: [1, 68, 300] }),
        },
        meituan: { self: column(), share: column() },
      };
      for (const [code, columns] of Object.entries(expected)) {
        const filtered = await summary(await d.get(`?platform=${code}`));
        expect(filtered, code).toEqual({
          as_of: filtered.as_of,
          ...columns,
          referral: everyPlatform,
        });
      }
      const unknown = await d.get('?platform=amazon');
      await refused(unknown, 400, 20001);
      expect(unknown.json()).toMatchObject({ data: { fields: ['platform'] } });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-13a#7] BR-FUND-25 earnings.dashboard.referral_visible 关闭时 referral 为 null，自购与分享照常',
  async () => {
    await withDashboard(
      db,
      NOV_12,
      async (d) => {
        const me = d.me.uid;
        await order(db, rules, { buyer: me, paidAt: NOV_12_PAID, people: self(me, 200) }); // 17
        const friend = await invitee(db, me);
        const people = referred(friend, me, 1000);
        await order(db, rules, { buyer: friend, paidAt: NOV_12_PAID, people });
        await credit(
          db,
          await books(db, me, counter),
          {
            orderKey: await creditedOrder(db, rules, friend, people),
            role: 'direct',
            type: 'REFERRAL_CREDIT',
            subType: 'DIRECT',
            fen: 40n,
          },
          '2026-11-08',
        );
        for (const query of ['', '?platform=taobao']) {
          const data = await summary(await d.get(query));
          expect(data, query).toEqual({
            as_of: data.as_of,
            self: column({ today: [1, 17, 0], this_month: [1, 17, 0] }),
            share: column(),
            referral: null,
          });
        }
      },
      { 'earnings.dashboard.referral_visible': false },
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-13a#8] BR-FUND-25 earnings.dashboard.enabled 关闭时接口返回 404 / 30701，不返回任何数字',
  async () => {
    await withDashboard(
      db,
      NOV_12,
      async (d) => {
        const me = d.me.uid;
        await order(db, rules, { buyer: me, paidAt: NOV_12_PAID, people: self(me, 200) });
        for (const query of ['', '?platform=jd']) {
          const response = await d.get(query);
          await refused(response, 404, 30701);
          expect(response.json(), query).not.toHaveProperty('data.self');
        }
      },
      { 'earnings.dashboard.enabled': false, 'earnings.dashboard.referral_visible': true },
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-13a#9] BR-FUND-25 只返回本人数据、没有收益时各栏照常为 0；未登录 401 / 10001；读取不写库',
  async () => {
    await withDashboard(db, NOV_12, async (d) => {
      const other = d.someone.uid;
      await order(db, rules, { buyer: other, paidAt: NOV_12_PAID, people: self(other, 200) }); // 17
      await credit(
        db,
        await books(db, other, counter),
        {
          orderKey: await creditedOrder(db, rules, other, self(other, 5000)),
          role: 'self',
          type: 'REBATE_CREDIT',
          fen: 33n,
        },
        '2026-11-12',
      );
      const theirFriend = await invitee(db, other);
      await order(db, rules, {
        buyer: theirFriend,
        paidAt: NOV_12_PAID,
        people: referred(theirFriend, other, 1000),
      }); // 85
      const before = await footprint(db);

      const mine = await summary(await d.get());
      expect(mine).toEqual({
        as_of: mine.as_of,
        self: column(),
        share: column(),
        referral: referral(),
      });
      const theirs = await summary(await d.get('', d.someone));
      expect(theirs).toEqual({
        as_of: theirs.as_of,
        self: column({ today: [1, 17, 33], this_month: [1, 17, 33] }),
        share: column(),
        referral: referral([85, 0]),
      });
      const anonymous = await d.get('', null);
      expect(anonymous.statusCode, anonymous.body).toBe(401);
      expect(anonymous.json()).toMatchObject({ code: 10001 });
      expect(anonymous.json()).not.toHaveProperty('data.self');
      expect(await footprint(db)).toEqual(before);
    });
  },
  TIMEOUT,
);
