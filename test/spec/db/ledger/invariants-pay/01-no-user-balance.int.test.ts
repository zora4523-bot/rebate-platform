// B2-15j pay-01 rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07 正文（支付模块不得产生
// 任何 USER_BALANCE 分录）与细则「不变量」①（带支付单、退款单或异常收款引用的凭证里不得出现 USER_BALANCE
// 科目）。Top-level it() only (规划/11 §4.3).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  APP,
  OTHER_APP,
  TIMEOUT,
  anomalyReceipt,
  anomalyRefundVoucher,
  clean,
  detailContains,
  differences,
  feeVoucher,
  payAnomaly,
  payOrder,
  payRefund,
  post,
  rebateVoucher,
  receipt,
  refundVoucher,
  scenario,
  userAccount,
  type Voucher,
} from './kit.ts';

it(
  '[AC-B2-15j#40] pay-01 干净数据：收款、退款、异常收款登记与退款、手续费凭证只记平台科目 → 0 差异，检查行数为收款类凭证张数（用户侧返利凭证不计入）；再写一张落到用户账户的退款凭证 → 报该用户账户一条差异',
  async () => {
    await scenario(createTestDatabase, 'pay-01', async ({ db, check }) => {
      const order = await payOrder(db);
      await receipt(db, order);
      const refund = await payRefund(db, order, { amount: 1_000n });
      await refundVoucher(db, order, refund);
      const closed = await payOrder(db, { status: 'CLOSED', channel: 'alipay' });
      const anomaly = await payAnomaly(db, { order: closed });
      await anomalyReceipt(db, anomaly);
      const back = await payRefund(db, anomaly, { amount: 345n });
      await anomalyRefundVoucher(db, anomaly, back);
      await feeVoucher(db, APP, 'wechat_pay', '2032-06-14', 75n);
      const user = await userAccount(db, APP);
      await rebateVoucher(db, user);
      clean(await check(5n));

      const bad = await payRefund(db, order, { amount: 200n });
      const v = await post(db, {
        app: APP,
        bizType: 'pay_refund',
        bizId: bad.id,
        uniqKey: `PAY_REFUND:${bad.id}`,
        kind: 'PAY_REFUND',
        ledgerType: 'PAY_REFUND',
        subType: order.pay_channel,
        lines: [
          { to: `PAY_RECEIPTS:${order.biz_type}`, amount: 200n },
          { to: user, amount: -200n },
        ],
      });
      const rows = await check(6n);
      differences(rows, 'account');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ app_id: APP, account_id: user.id });
      detailContains(rows, v.id, `PAY_REFUND:${bad.id}`, 'pay_refund', bad.id);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-15j#41] pay-01 每种引用都查：支付单、异常收款、退款单引用的凭证与 PAY_FEE 凭证、以及分录类型为 PAY_* 的凭证落到用户账户，各报一条（每张凭证、每个用户账户一行，金额合计精确）',
  async () => {
    await scenario(createTestDatabase, 'pay-01', async ({ db, check }) => {
      const order = await payOrder(db, { amount: 9_007_199_254_740_993n });
      const anomaly = await payAnomaly(db);
      const refund = await payRefund(db, order);
      const users = await Promise.all([1, 2, 3, 4, 5].map(() => userAccount(db, APP)));
      const hits = [
        { bizType: 'pay_order', bizId: order.id, kind: 'PAY_RECEIPT', type: 'PAY_RECEIPT' },
        { bizType: 'pay_anomaly', bizId: anomaly.id, kind: 'PAY_ANOMALY', type: 'PAY_ANOMALY' },
        { bizType: 'pay_refund', bizId: refund.id, kind: 'PAY_REFUND', type: 'PAY_REFUND' },
        { bizType: 'pay_bill', bizId: 'wechat_pay:2032-06-14', kind: 'PAY_FEE', type: 'PAY_FEE' },
        // Neither a payment reference nor a payment kind: only the entries say PAY_RECEIPT.
        { bizType: 'order', bizId: order.id, kind: null, type: 'PAY_RECEIPT' },
      ] as const;
      const vouchers: Voucher[] = [];
      for (const [index, hit] of hits.entries()) {
        vouchers.push(
          await post(db, {
            app: APP,
            bizType: hit.bizType,
            bizId: hit.bizId,
            uniqKey: `fixture:${hit.type}:${index}`,
            kind: hit.kind,
            ledgerType: hit.type,
            subType: 'wechat_pay',
            lines: [
              { to: users[index]!, amount: -order.amount_fen },
              { to: 'CASH_PAY:wechat_pay', amount: order.amount_fen },
            ],
          }),
        );
      }
      const rows = await check(5n);
      differences(rows, 'account');
      expect(rows).toHaveLength(5);
      expect(rows.map((row) => row.account_id).sort()).toEqual(users.map((u) => u.id).sort());
      for (const v of vouchers) detailContains(rows, v.id);
      detailContains(rows, '-9007199254740993');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-15j#42] pay-01 app 隔离：另一 app 的收款凭证落到用户账户只按那个 app 报；用户侧返利凭证（非收款类）即使有 USER_BALANCE 也不进检查行数、不报差异',
  async () => {
    await scenario(createTestDatabase, 'pay-01', async ({ db, check }) => {
      const mine = await payOrder(db);
      await receipt(db, mine);
      await rebateVoucher(db, await userAccount(db, APP));
      const theirs = await payOrder(db, { app: OTHER_APP });
      const foreignUser = await userAccount(db, OTHER_APP);
      await post(db, {
        app: OTHER_APP,
        bizType: 'pay_order',
        bizId: theirs.id,
        uniqKey: `PAY_RECEIPT:${theirs.id}`,
        kind: 'PAY_RECEIPT',
        ledgerType: 'PAY_RECEIPT',
        subType: theirs.pay_channel,
        lines: [
          { to: `CASH_PAY:${theirs.pay_channel}`, amount: theirs.amount_fen },
          { to: foreignUser, amount: -theirs.amount_fen },
        ],
      });
      const rows = await check(2n);
      differences(rows, 'account');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ app_id: OTHER_APP, account_id: foreignUser.id });
      detailContains(rows, theirs.id);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-15j#43] pay-01 没有收款类凭证时只返回检查行数为 0 的哨兵行（日终运行器据此记空检告警），不当作通过的检查',
  async () => {
    await scenario(createTestDatabase, 'pay-01', async ({ db, empty }) => {
      await rebateVoucher(db, await userAccount(db, APP));
      await empty();
    });
  },
  TIMEOUT,
);
