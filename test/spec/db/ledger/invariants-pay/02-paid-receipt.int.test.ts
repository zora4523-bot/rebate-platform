// B2-15j pay-02 rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07 细则「不变量」②（每张
// PAID 支付单恰有一张 PAY_RECEIPT 凭证）；BR-PAY-07 正文（PAY_RECEIPT 每张支付单至多一张，凭证唯一键：
// 类型 + 支付单）；BR-PAY-05 ④（CLOSED 的单不得再变为 PAID，其收款只登记为异常收款）。
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { subFen } from '@couli/money';
import { expect, it } from 'vitest';
import {
  APP,
  OTHER_APP,
  TIMEOUT,
  anomalyReceipt,
  clean,
  detailContains,
  differences,
  mentioning,
  payAnomaly,
  payOrder,
  post,
  receipt,
  scenario,
  type PayOrder,
} from './kit.ts';

it(
  '[AC-B2-15j#44] pay-02 干净数据：两渠道各一张 PAID 单各一张 PAY_RECEIPT，PENDING / CLOSED 单无收款凭证（CLOSED 单的收款是异常收款凭证）→ 0 差异，检查行数 = PAID 单数；再有一张 PAID 单缺收款凭证 → 报该单（应 1 实 0）',
  async () => {
    await scenario(createTestDatabase, 'pay-02', async ({ db, check }) => {
      for (const channel of ['wechat_pay', 'alipay'] as const) {
        await receipt(db, await payOrder(db, { channel }));
      }
      await payOrder(db, { status: 'PENDING' });
      const closed = await payOrder(db, { status: 'CLOSED', channel: 'alipay' });
      await anomalyReceipt(db, await payAnomaly(db, { order: closed }));
      clean(await check(2n));

      const missing = await payOrder(db, { channel: 'alipay', amount: 990n });
      const rows = await check(3n);
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.app_id).toBe(APP);
      detailContains(rows, missing.id, 'PAID', '1', '0');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-15j#45] pay-02 重复收款：同一 PAID 单第二张收款凭证（另一唯一键；或 voucher_kind 为空、只有 PAY_RECEIPT 分录）都算，报应 1 实 2',
  async () => {
    await scenario(createTestDatabase, 'pay-02', async ({ db, check }) => {
      const a = await payOrder(db);
      await receipt(db, a);
      await receipt(db, a, { uniqKey: `PAY_RECEIPT:${a.id}:again` });
      const b = await payOrder(db, { channel: 'alipay' });
      await receipt(db, b);
      await receipt(db, b, { uniqKey: `fixture:${b.id}`, kind: null });
      const ok = await payOrder(db);
      await receipt(db, ok);
      const rows = await check(3n);
      differences(rows, 'global');
      expect(rows).toHaveLength(2);
      for (const order of [a, b]) {
        const hit = mentioning(rows, order.id);
        expect(hit).toHaveLength(1);
        detailContains(hit, '1', '2');
      }
      expect(mentioning(rows, ok.id)).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-15j#46] pay-02 非 PAID 单有收款凭证：CLOSED 单、PENDING 单、我方没有的支付单号各报一条（应 0），都计入检查行数',
  async () => {
    await scenario(createTestDatabase, 'pay-02', async ({ db, check }) => {
      const closed = await payOrder(db, { status: 'CLOSED' });
      await receipt(db, closed);
      const pending = await payOrder(db, { status: 'PENDING', channel: 'alipay' });
      await receipt(db, pending);
      // A merchant number of ours that has no pay_orders row at all.
      const ghost: PayOrder = {
        app: APP,
        id: randomUUID(),
        out_trade_no: 'PGHOST0000000000000001',
        pay_channel: 'wechat_pay',
        biz_type: 'test_item',
        amount_fen: 500n,
        status: 'PAID',
      };
      await receipt(db, ghost);
      const paid = await payOrder(db);
      await receipt(db, paid);
      const rows = await check(4n);
      differences(rows, 'global');
      expect(rows).toHaveLength(3);
      for (const order of [closed, pending]) detailContains(mentioning(rows, order.id), '0', '1');
      detailContains(mentioning(rows, ghost.id), '0', '1');
      expect(mentioning(rows, paid.id)).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-15j#47] pay-02 按 (app_id, 支付单) 对上：另一 app 同号的收款凭证不能替本 app 的 PAID 单充数；异常收款凭证（biz_type pay_anomaly）不算收款凭证',
  async () => {
    await scenario(createTestDatabase, 'pay-02', async ({ db, check }) => {
      const order = await payOrder(db);
      await post(db, {
        app: OTHER_APP,
        bizType: 'pay_order',
        bizId: order.id,
        uniqKey: `PAY_RECEIPT:${order.id}`,
        kind: 'PAY_RECEIPT',
        ledgerType: 'PAY_RECEIPT',
        subType: order.pay_channel,
        lines: [
          { to: `CASH_PAY:${order.pay_channel}`, amount: order.amount_fen },
          { to: `PAY_RECEIPTS:${order.biz_type}`, amount: subFen(0n, order.amount_fen) },
        ],
      });
      await post(db, {
        app: APP,
        bizType: 'pay_anomaly',
        bizId: order.id,
        uniqKey: `PAY_ANOMALY:${order.id}`,
        kind: 'PAY_ANOMALY',
        ledgerType: 'PAY_ANOMALY',
        subType: order.pay_channel,
        lines: [
          { to: `CASH_PAY:${order.pay_channel}`, amount: order.amount_fen },
          { to: 'PAY_SUSPENSE', amount: subFen(0n, order.amount_fen) },
        ],
      });
      const rows = await check(2n);
      differences(rows, 'global');
      expect(rows).toHaveLength(2);
      const mine = rows.filter((row) => row.app_id === APP);
      expect(mine).toHaveLength(1);
      detailContains(mine, order.id, 'PAID', '1', '0');
      const theirs = rows.filter((row) => row.app_id === OTHER_APP);
      expect(theirs).toHaveLength(1);
      detailContains(theirs, order.id, '0', '1');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-15j#48] pay-02 没有 PAID 单也没有收款凭证时只返回检查行数为 0 的哨兵行',
  async () => {
    await scenario(createTestDatabase, 'pay-02', async ({ db, empty }) => {
      await payOrder(db, { status: 'PENDING' });
      await payOrder(db, { status: 'CLOSED' });
      await empty();
    });
  },
  TIMEOUT,
);
