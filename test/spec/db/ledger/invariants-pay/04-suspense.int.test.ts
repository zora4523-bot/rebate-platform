// B2-15j pay-04 rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07 细则「不变量」④
// （PAY_SUSPENSE 的余额等于未退完的异常收款合计）；BR-PAY-07 正文（PAY_ANOMALY 登记时借 CASH_PAY / 贷
// PAY_SUSPENSE，对异常收款退款成功时写相反方向）；BR-PAY-05 ④（这笔钱只能经 BR-PAY-06 原路退回）。
// Top-level it() only (规划/11 §4.3).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  APP,
  OTHER_APP,
  TIMEOUT,
  anomalyReceipt,
  anomalyRefundVoucher,
  bumpRefunded,
  clean,
  detailContains,
  differences,
  payAnomaly,
  payOrder,
  payRefund,
  scenario,
} from './kit.ts';

it(
  '[AC-B2-15j#53] pay-04 干净数据：未退的 12345、部分退 300 的 990、全额退完的 1900 → PAY_SUSPENSE 余额 13035 = 未退完合计，0 差异，检查行数 = app 数；再登记一条 500 的异常收款却漏写 PAY_ANOMALY → 报应 13535 实 13035',
  async () => {
    await scenario(createTestDatabase, 'pay-04', async ({ db, check }) => {
      const closed = await payOrder(db, { status: 'CLOSED' });
      const open = await payAnomaly(db, { order: closed });
      await anomalyReceipt(db, open);
      const partial = await payAnomaly(db, { channel: 'alipay', amount: 990n });
      await anomalyReceipt(db, partial);
      await anomalyRefundVoucher(db, partial, await payRefund(db, partial, { amount: 300n }));
      // A refund still processing does not lower the amount waiting to go back.
      await payRefund(db, partial, { amount: 100n, status: 'PROCESSING' });
      const done = await payAnomaly(db, { amount: 1_900n });
      await anomalyReceipt(db, done);
      await anomalyRefundVoucher(db, done, await payRefund(db, done, { amount: 1_900n }));
      clean(await check(1n));

      const unbooked = await payAnomaly(db, { amount: 500n });
      expect(unbooked.app).toBe(APP);
      const rows = await check(1n);
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.app_id).toBe(APP);
      detailContains(rows, '13035', '13535');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-15j#54] pay-04 两侧各自失配：反向 PAY_ANOMALY 已记而 refunded_fen 未加 → 余额小于待退；refunded_fen 加了而没有反向凭证 → 余额大于待退；有异常收款却从未有 PAY_SUSPENSE 分录也要报',
  async () => {
    await scenario(createTestDatabase, 'pay-04', async ({ db, check }) => {
      const a = await payAnomaly(db, { amount: 1_000n });
      await anomalyReceipt(db, a);
      await anomalyRefundVoucher(
        db,
        a,
        await payRefund(db, a, { amount: 400n, bookTarget: false }),
      );
      const first = await check(1n);
      differences(first, 'global');
      detailContains(first, '600', '1000');

      await bumpRefunded(db, a, 400n);
      clean(await check(1n));

      await bumpRefunded(db, a, 100n);
      const second = await check(1n);
      differences(second, 'global');
      detailContains(second, '600', '500');

      const foreign = await payAnomaly(db, { app: OTHER_APP, amount: 777n });
      expect(foreign.app).toBe(OTHER_APP);
      const third = await check(2n);
      differences(third, 'global');
      expect(third.map((row) => row.app_id).sort()).toEqual([APP, OTHER_APP]);
      detailContains(
        third.filter((row) => row.app_id === OTHER_APP),
        '0',
        '777',
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-15j#55] pay-04 app 隔离与精度：另一 app 多出的 PAY_SUSPENSE 不能抵消本 app 的缺口；大于 2^53 的金额差一分也报',
  async () => {
    await scenario(createTestDatabase, 'pay-04', async ({ db, check }) => {
      const big = await payAnomaly(db, { amount: 9_007_199_254_740_993n });
      await anomalyReceipt(db, { ...big, amount_fen: 9_007_199_254_740_992n });
      const other = await payAnomaly(db, { app: OTHER_APP, amount: 1n });
      await anomalyReceipt(db, { ...other, amount_fen: 2n });
      const rows = await check(2n);
      differences(rows, 'global');
      expect(rows).toHaveLength(2);
      detailContains(
        rows.filter((row) => row.app_id === APP),
        '9007199254740992',
        '9007199254740993',
      );
      detailContains(
        rows.filter((row) => row.app_id === OTHER_APP),
        '2',
        '1',
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-15j#56] pay-04 没有异常收款也没有 PAY_SUSPENSE 分录时只返回检查行数为 0 的哨兵行',
  async () => {
    await scenario(createTestDatabase, 'pay-04', async ({ db, empty }) => {
      await payOrder(db, { status: 'CLOSED' });
      await empty();
    });
  },
  TIMEOUT,
);
