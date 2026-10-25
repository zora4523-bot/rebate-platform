// B2-15j pay-03 rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07 细则「不变量」③（每张
// SUCCESS 退款单恰有一张 PAY_REFUND，或对异常收款的反向 PAY_ANOMALY 凭证）；BR-PAY-07 正文（PAY_REFUND
// 退款单 SUCCESS 时写、每张退款单至多一张；对异常收款的退款成功时写相反方向）；BR-PAY-06 ⑤。
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
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
  mentioning,
  payAnomaly,
  payOrder,
  payRefund,
  receipt,
  refundVoucher,
  scenario,
  type PayRefund,
} from './kit.ts';

it(
  '[AC-B2-15j#49] pay-03 干净数据：支付单的 SUCCESS 退款一张 PAY_REFUND、异常收款的 SUCCESS 退款一张反向 PAY_ANOMALY（借 PAY_SUSPENSE），PROCESSING / FAILED 退款无凭证 → 0 差异，检查行数 = SUCCESS 退款数；再有一张 SUCCESS 退款缺凭证 → 报该退款单',
  async () => {
    await scenario(createTestDatabase, 'pay-03', async ({ db, check }) => {
      const order = await payOrder(db);
      await receipt(db, order);
      await refundVoucher(db, order, await payRefund(db, order, { amount: 1_000n }));
      await payRefund(db, order, { amount: 500n, status: 'PROCESSING' });
      await payRefund(db, order, { amount: 700n, status: 'FAILED' });
      const anomaly = await payAnomaly(db, { channel: 'alipay', amount: 990n });
      await anomalyReceipt(db, anomaly);
      await anomalyRefundVoucher(db, anomaly, await payRefund(db, anomaly, { amount: 990n }));
      clean(await check(2n));

      const missing = await payRefund(db, order, { amount: 300n });
      const rows = await check(3n);
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.app_id).toBe(APP);
      detailContains(rows, missing.id, missing.out_refund_no, 'SUCCESS', 'PAY_REFUND');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-15j#50] pay-03 凭证张数与方向：SUCCESS 退款两张 PAY_REFUND；异常收款退款写成 PAY_REFUND 而非反向 PAY_ANOMALY；异常收款退款的 PAY_ANOMALY 方向写反（贷 PAY_SUSPENSE）；支付单退款写成 PAY_ANOMALY → 各报一条',
  async () => {
    await scenario(createTestDatabase, 'pay-03', async ({ db, check }) => {
      const order = await payOrder(db);
      const twice = await payRefund(db, order, { amount: 100n });
      await refundVoucher(db, order, twice);
      await refundVoucher(db, order, twice, { uniqKey: `PAY_REFUND:${twice.id}:again` });

      const anomaly = await payAnomaly(db, { amount: 5_000n });
      const asRefund = await payRefund(db, anomaly, { amount: 1_000n });
      await refundVoucher(db, order, asRefund);
      const forward = await payRefund(db, anomaly, { amount: 2_000n });
      await anomalyRefundVoucher(db, anomaly, forward, { forward: true });

      const orderAsAnomaly = await payRefund(db, order, { amount: 200n });
      await anomalyRefundVoucher(db, anomaly, orderAsAnomaly);

      const fine = await payRefund(db, order, { amount: 50n });
      await refundVoucher(db, order, fine);
      const rows = await check(5n);
      differences(rows, 'global');
      expect(rows).toHaveLength(4);
      for (const refund of [twice, asRefund, forward, orderAsAnomaly]) {
        expect(mentioning(rows, refund.id), refund.id).toHaveLength(1);
      }
      detailContains(mentioning(rows, twice.id), 'PAY_REFUND', '2');
      detailContains(mentioning(rows, asRefund.id), 'PAY_ANOMALY', 'pay_anomaly');
      detailContains(mentioning(rows, forward.id), 'PAY_ANOMALY', 'pay_anomaly');
      detailContains(mentioning(rows, orderAsAnomaly.id), 'PAY_REFUND', 'pay_order');
      expect(mentioning(rows, fine.id)).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-15j#51] pay-03 非 SUCCESS 退款有凭证：PROCESSING、FAILED 退款单与我方没有的退款单号的退款凭证各报一条，都计入检查行数；另一 app 同号凭证不能替本 app 的 SUCCESS 退款充数',
  async () => {
    await scenario(createTestDatabase, 'pay-03', async ({ db, check }) => {
      const order = await payOrder(db);
      const processing = await payRefund(db, order, { amount: 100n, status: 'PROCESSING' });
      await refundVoucher(db, order, processing);
      const failed = await payRefund(db, order, { amount: 200n, status: 'FAILED' });
      await refundVoucher(db, order, failed);
      const ghost: PayRefund = {
        app: APP,
        id: randomUUID(),
        out_refund_no: 'RGHOST0000000000000001',
        target_type: 'pay_order',
        target_id: order.id,
        amount_fen: 300n,
        status: 'SUCCESS',
      };
      await refundVoucher(db, order, ghost);
      const lonely = await payRefund(db, order, { amount: 400n });
      await refundVoucher(db, order, { ...lonely, app: OTHER_APP });
      const rows = await check(5n);
      differences(rows, 'global');
      expect(rows).toHaveLength(5);
      for (const refund of [processing, failed, ghost]) {
        const hit = mentioning(rows, refund.id);
        expect(hit, refund.id).toHaveLength(1);
        expect(hit[0]!.app_id).toBe(APP);
        detailContains(hit, 'none');
      }
      const mine = mentioning(rows, lonely.id).filter((row) => row.app_id === APP);
      expect(mine).toHaveLength(1);
      detailContains(mine, 'SUCCESS', 'PAY_REFUND', '0');
      const theirs = mentioning(rows, lonely.id).filter((row) => row.app_id === OTHER_APP);
      expect(theirs).toHaveLength(1);
      detailContains(theirs, 'none', '1');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-15j#52] pay-03 没有 SUCCESS 退款也没有退款凭证时只返回检查行数为 0 的哨兵行',
  async () => {
    await scenario(createTestDatabase, 'pay-03', async ({ db, empty }) => {
      const order = await payOrder(db);
      await receipt(db, order);
      await payRefund(db, order, { status: 'PROCESSING' });
      await payRefund(db, order, { status: 'FAILED' });
      await empty();
    });
  },
  TIMEOUT,
);
