// B2-04zc · BR-FUND-15、BR-TEXT-19：GET /v1/wallet/ledger 经正式 api 入口与测试库读取，时钟注入。
// 各用例的期望条目手写：amount_fen 为对可用余额的影响（入账正、扣减负，BR-TEXT-19「符号表示对
// 可用余额的影响」），balance_after_fen 为该分录记账后的可用余额（可为负）；每张打款成功的提现单
// 1 条 WITHDRAW_PAID 汇总条目，amount_fen = −实际到账（withdrawals.net_fen，契约例子为负），带
// fee_fen、tax_fen，balance_after_fen 为 null；会计日取记账时刻的 +08:00 日期。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { platform, type Account } from '../../db/ledger/invariants/kit.ts';
import {
  TIMEOUT,
  clawback,
  counterAccount,
  credit,
  everything,
  invitee,
  ledger,
  maskedRow,
  page,
  paidRow,
  placed,
  reverse,
  row,
  ruleVersion,
  settleAdjust,
  unlinked,
  withLedger,
  withdraw,
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

function self(userId: string): Person[] {
  return [{ userId, role: 'self', ratioBp: 5000 }];
}
function share(userId: string): Person[] {
  return [{ userId, role: 'share', ratioBp: 5000 }];
}

it(
  '[AC-B2-04zc#1] BR-FUND-15 只列本人 available 子户分录与打款成功的汇总条目：frozen 子户、平台科目、他人与别的 app 的分录都不出现，WITHDRAW_FEE / TAX_WITHHOLD 不单独成行',
  async () => {
    await withLedger(db, async (r) => {
      const me = await ledger(db, r.me.uid, counter);
      const mine = await placed(db, rules, r.me.uid, self(r.me.uid));
      credit(me, 'REBATE_CREDIT', {
        order: mine,
        role: 'self',
        fen: 800n,
        at: '2026-10-05T10:00:00+08:00',
      });
      const paid = await withdraw(db, me, {
        status: 'PAID_API',
        amount: 500n,
        fee: 20n,
        tax: 30n,
        appliedAt: '2026-10-06T09:00:00+08:00',
        settledAt: '2026-10-06T15:00:00+08:00',
      });
      const pending = await withdraw(db, me, {
        status: 'PENDING_REVIEW',
        amount: 100n,
        appliedAt: '2026-10-07T09:00:00+08:00',
      });
      await me.flush();
      // 同一 app 的另一个用户：入账与打款成功的提现都不进本人流水。
      const other = await ledger(db, r.someone.uid, counter);
      const theirs = await placed(db, rules, r.someone.uid, self(r.someone.uid));
      credit(other, 'REBATE_CREDIT', {
        order: theirs,
        role: 'self',
        fen: 9999n,
        at: '2026-10-06T12:00:00+08:00',
      });
      await withdraw(db, other, {
        status: 'PAID_API',
        amount: 300n,
        fee: 3n,
        appliedAt: '2026-10-06T12:30:00+08:00',
        settledAt: '2026-10-06T13:00:00+08:00',
      });
      await other.flush();
      // 同一 uid 在别的 app 下的账户。
      const otherApp = `couli-other-${randomUUID()}`;
      const elsewhere = await ledger(
        db,
        r.me.uid,
        await platform(db, 'UNION_RECEIVABLE:taobao', otherApp),
        otherApp,
      );
      unlinked(elsewhere, 'ADMIN_ADJUST', 'OTHER', 7777n, '2026-10-06T14:00:00+08:00');
      await elsewhere.flush();

      expect(await everything(r)).toEqual([
        row('WITHDRAW_FREEZE', null, -100, '2026-10-07', 200, ['withdrawal', pending]),
        paidRow(paid, 450, 20, 30, '2026-10-06'),
        row('WITHDRAW_FREEZE', null, -500, '2026-10-06', 300, ['withdrawal', paid]),
        row('REBATE_CREDIT', null, 800, '2026-10-05', 800, ['order', mine.id]),
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zc#2] BR-FUND-15 每张 PAID_API / PAID_MANUAL 提现单恰好 1 条 WITHDRAW_PAID 汇总条目（−实际到账、税费、无变动后余额）；审核中、已通过、打款中、驳回、失败的没有汇总条目',
  async () => {
    await withLedger(db, async (r) => {
      const me = await ledger(db, r.me.uid, counter);
      const mine = await placed(db, rules, r.me.uid, self(r.me.uid));
      credit(me, 'REBATE_CREDIT', {
        order: mine,
        role: 'self',
        fen: 10_000n,
        at: '2026-10-01T10:00:00+08:00',
      });
      const day = (d: string, time = '09:00:00') => `2026-10-${d}T${time}+08:00`;
      const reviewing = await withdraw(db, me, {
        status: 'PENDING_REVIEW',
        amount: 101n,
        appliedAt: day('02'),
      });
      const approved = await withdraw(db, me, {
        status: 'APPROVED',
        amount: 102n,
        appliedAt: day('03'),
      });
      const paying = await withdraw(db, me, {
        status: 'PAYING',
        amount: 103n,
        fee: 1n,
        appliedAt: day('04'),
      });
      const rejected = await withdraw(db, me, {
        status: 'REJECTED',
        amount: 104n,
        appliedAt: day('05'),
        settledAt: day('05', '18:00:00'),
      });
      const failed = await withdraw(db, me, {
        status: 'FAILED',
        amount: 105n,
        tax: 5n,
        appliedAt: day('06'),
        settledAt: day('07', '10:00:00'),
      });
      // BR-TEXT-19 例 2 的形状：申请 1000、代扣 80，另加手续费 10 → 实际到账 910。
      const api = await withdraw(db, me, {
        status: 'PAID_API',
        amount: 1000n,
        fee: 10n,
        tax: 80n,
        appliedAt: day('08'),
        settledAt: day('09', '11:00:00'),
      });
      // 无税费：打款凭证只有 WITHDRAW_PAID 一种分录，汇总条目的 fee_fen、tax_fen 照样为 0。
      const manual = await withdraw(db, me, {
        status: 'PAID_MANUAL',
        amount: 600n,
        appliedAt: day('10'),
        settledAt: day('12', '16:00:00'),
      });
      await me.flush();

      const items = await everything(r);
      expect(items).toEqual([
        paidRow(manual, 600, 0, 0, '2026-10-12'),
        row('WITHDRAW_FREEZE', null, -600, '2026-10-10', 8094, ['withdrawal', manual]),
        paidRow(api, 910, 10, 80, '2026-10-09'),
        row('WITHDRAW_FREEZE', null, -1000, '2026-10-08', 8694, ['withdrawal', api]),
        row('WITHDRAW_RETURN', null, 105, '2026-10-07', 9694, ['withdrawal', failed]),
        row('WITHDRAW_FREEZE', null, -105, '2026-10-06', 9589, ['withdrawal', failed]),
        row('WITHDRAW_RETURN', null, 104, '2026-10-05', 9694, ['withdrawal', rejected]),
        row('WITHDRAW_FREEZE', null, -104, '2026-10-05', 9590, ['withdrawal', rejected]),
        row('WITHDRAW_FREEZE', null, -103, '2026-10-04', 9694, ['withdrawal', paying]),
        row('WITHDRAW_FREEZE', null, -102, '2026-10-03', 9797, ['withdrawal', approved]),
        row('WITHDRAW_FREEZE', null, -101, '2026-10-02', 9899, ['withdrawal', reviewing]),
        row('REBATE_CREDIT', null, 10_000, '2026-10-01', 10_000, ['order', mine.id]),
      ]);
      const summaries = (id: string) =>
        items.filter((item) => item.ledger_type === 'WITHDRAW_PAID' && item.link_id === id);
      for (const id of [api, manual]) expect(summaries(id), id).toHaveLength(1);
      for (const id of [reviewing, approved, paying, rejected, failed]) {
        expect(summaries(id), id).toHaveLength(0);
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zc#3] BR-FUND-15 / BR-TEXT-19 分录行带符号金额、ledger_type、sub_type、会计日与记账后的可用余额：扣回、补差、调账可使余额为负，红冲沿用原类型且为负',
  async () => {
    await withLedger(db, async (r) => {
      const me = await ledger(db, r.me.uid, counter);
      const first = await placed(db, rules, r.me.uid, self(r.me.uid));
      const corrected = await placed(db, rules, r.me.uid, self(r.me.uid));
      const on = (order: typeof first, fen: bigint, at: string, subType: string | null = null) => ({
        order,
        role: 'self' as const,
        subType,
        fen,
        at,
      });
      credit(me, 'REBATE_CREDIT', on(first, 300n, '2026-10-10T10:00:00+08:00'));
      clawback(me, on(first, -120n, '2026-10-11T10:00:00+08:00', 'PART_REFUND'));
      settleAdjust(me, on(first, -250n, '2026-10-12T10:00:00+08:00', 'SETTLE_DIFF'));
      settleAdjust(me, on(first, 20n, '2026-10-13T10:00:00+08:00', 'PRICE_PROTECT'));
      unlinked(me, 'ADMIN_ADJUST', 'RECON_FIX', -30n, '2026-10-14T10:00:00+08:00');
      unlinked(me, 'BAD_DEBT_WRITEOFF', null, 80n, '2026-10-15T10:00:00+08:00');
      credit(me, 'REBATE_CREDIT', on(corrected, 500n, '2026-10-16T10:00:00+08:00'));
      reverse(me, 'REBATE_CREDIT', on(corrected, -500n, '2026-10-17T10:00:00+08:00'));
      unlinked(me, 'REWARD', 'invite', 1000n, '2026-10-18T10:00:00+08:00');
      await me.flush();

      expect(await everything(r)).toEqual([
        row('REWARD', 'invite', 1000, '2026-10-18', 1000),
        row('REBATE_CREDIT', null, -500, '2026-10-17', 0, ['order', corrected.id]),
        row('REBATE_CREDIT', null, 500, '2026-10-16', 500, ['order', corrected.id]),
        row('BAD_DEBT_WRITEOFF', null, 80, '2026-10-15', 0),
        row('ADMIN_ADJUST', 'RECON_FIX', -30, '2026-10-14', -80),
        row('SETTLE_ADJUST', 'PRICE_PROTECT', 20, '2026-10-13', -50, ['order', first.id]),
        row('SETTLE_ADJUST', 'SETTLE_DIFF', -250, '2026-10-12', -70, ['order', first.id]),
        row('CLAWBACK', 'PART_REFUND', -120, '2026-10-11', 180, ['order', first.id]),
        row('REBATE_CREDIT', null, 300, '2026-10-10', 300, ['order', first.id]),
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zc#4] BR-TEXT-19 跳转：分享单的 SHARE_CREDIT / CLAWBACK / SETTLE_ADJUST 关联子订单号，WITHDRAW_FREEZE / RETURN 关联提现单号，无关联单据的 ADMIN_ADJUST 不跳转',
  async () => {
    await withLedger(db, async (r) => {
      const me = await ledger(db, r.me.uid, counter);
      const shared = await placed(db, rules, r.me.uid, share(r.me.uid), 'share');
      const on = (fen: bigint, at: string, subType: string | null = null) => ({
        order: shared,
        role: 'share' as const,
        subType,
        fen,
        at,
      });
      credit(me, 'SHARE_CREDIT', on(260n, '2026-10-20T10:00:00+08:00'));
      clawback(me, on(-60n, '2026-10-21T10:00:00+08:00', 'RIGHTS'));
      settleAdjust(me, on(-10n, '2026-10-22T10:00:00+08:00', 'PRICE_COMPARE'));
      const failed = await withdraw(db, me, {
        status: 'FAILED',
        amount: 100n,
        appliedAt: '2026-10-23T09:00:00+08:00',
        settledAt: '2026-10-23T12:00:00+08:00',
      });
      unlinked(me, 'ADMIN_ADJUST', 'OTHER', 5n, '2026-10-24T10:00:00+08:00');
      unlinked(me, 'ADMIN_ADJUST', 'PAYOUT_RECOVERY', -5n, '2026-10-25T10:00:00+08:00');
      await me.flush();

      const response = await r.get('?limit=50');
      const data = await page(response);
      expect(data).toEqual({
        items: [
          row('ADMIN_ADJUST', 'PAYOUT_RECOVERY', -5, '2026-10-25', 190),
          row('ADMIN_ADJUST', 'OTHER', 5, '2026-10-24', 195),
          row('WITHDRAW_RETURN', null, 100, '2026-10-23', 190, ['withdrawal', failed]),
          row('WITHDRAW_FREEZE', null, -100, '2026-10-23', 90, ['withdrawal', failed]),
          row('SETTLE_ADJUST', 'PRICE_COMPARE', -10, '2026-10-22', 190, ['order', shared.id]),
          row('CLAWBACK', 'RIGHTS', -60, '2026-10-21', 200, ['order', shared.id]),
          row('SHARE_CREDIT', null, 260, '2026-10-20', 260, ['order', shared.id]),
        ],
        next_cursor: null,
      });
      // 跳转用子订单号（orders.order_id），不是凭证上的 order_key。
      expect(response.body).not.toContain(shared.key);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zc#5] BR-TEXT-19 / J7 邀请分佣（REFERRAL_CREDIT 直推、间推）与 referrer 角色的 CLAWBACK / SETTLE_ADJUST 一律 masked、不跳转、只到日，响应里没有任何订单号与下级 uid',
  async () => {
    await withLedger(db, async (r) => {
      const uid = r.me.uid;
      const me = await ledger(db, uid, counter);
      const friend = await invitee(db, uid);
      const grand = await invitee(db, friend);
      const direct = await placed(db, rules, friend, [
        { userId: friend, role: 'self', ratioBp: 5000 },
        { userId: uid, role: 'direct', ratioBp: 1000 },
      ]);
      const indirect = await placed(db, rules, grand, [
        { userId: grand, role: 'self', ratioBp: 5000 },
        { userId: friend, role: 'direct', ratioBp: 1000 },
        { userId: uid, role: 'indirect', ratioBp: 400 },
      ]);
      const friendShare = await placed(
        db,
        rules,
        friend,
        [
          { userId: friend, role: 'share', ratioBp: 5000 },
          { userId: uid, role: 'direct', ratioBp: 200 },
        ],
        'share',
      );
      const own = await placed(db, rules, uid, self(uid));
      credit(me, 'REFERRAL_CREDIT', {
        order: direct,
        role: 'direct',
        subType: 'DIRECT',
        fen: 150n,
        at: '2026-10-17T10:00:00+08:00',
      });
      credit(me, 'REFERRAL_CREDIT', {
        order: indirect,
        role: 'indirect',
        subType: 'INDIRECT',
        fen: 61n,
        at: '2026-10-17T11:00:00+08:00',
      });
      clawback(me, {
        order: direct,
        role: 'direct',
        subType: 'PART_REFUND',
        fen: -50n,
        at: '2026-10-18T10:00:00+08:00',
      });
      settleAdjust(me, {
        order: indirect,
        role: 'indirect',
        subType: 'SETTLE_DIFF',
        fen: 9n,
        at: '2026-10-19T10:00:00+08:00',
      });
      credit(me, 'REFERRAL_CREDIT', {
        order: friendShare,
        role: 'direct',
        subType: 'DIRECT',
        fen: 40n,
        at: '2026-10-20T10:00:00+08:00',
      });
      clawback(me, {
        order: friendShare,
        role: 'direct',
        subType: 'FULL',
        fen: -40n,
        at: '2026-10-21T10:00:00+08:00',
      });
      // 本人自购单照常跳转，与邀请分佣对照。
      credit(me, 'REBATE_CREDIT', {
        order: own,
        role: 'self',
        fen: 100n,
        at: '2026-10-22T10:00:00+08:00',
      });
      await me.flush();

      const response = await r.get('?limit=50');
      const data = await page(response);
      expect(data).toEqual({
        items: [
          row('REBATE_CREDIT', null, 100, '2026-10-22', 270, ['order', own.id]),
          maskedRow('CLAWBACK', 'FULL', -40, '2026-10-21', 170),
          maskedRow('REFERRAL_CREDIT', 'DIRECT', 40, '2026-10-20', 210),
          maskedRow('SETTLE_ADJUST', 'SETTLE_DIFF', 9, '2026-10-19', 170),
          maskedRow('CLAWBACK', 'PART_REFUND', -50, '2026-10-18', 161),
          maskedRow('REFERRAL_CREDIT', 'INDIRECT', 61, '2026-10-17', 211),
          maskedRow('REFERRAL_CREDIT', 'DIRECT', 150, '2026-10-17', 150),
        ],
        next_cursor: null,
      });
      for (const item of data.items.filter((i) => i.masked)) {
        expect(item.accounting_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      for (const secret of [
        friend,
        grand,
        direct.id,
        direct.key,
        indirect.id,
        indirect.key,
        friendShare.id,
        friendShare.key,
      ]) {
        expect(response.body).not.toContain(secret);
      }
    });
  },
  TIMEOUT,
);
