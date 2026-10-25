// B2-15j rerun and evidence rule tests (claude-independent, SPEC_REF 736d24c5; rule-test review r1): 08
// BR-PAY-07（按 out_refund_no 逐笔核对；对账按（渠道、账单日）幂等，差错单的 period 是账单日、不是运行日），
// BR-PAY-05 ④（异常收款登记渠道、渠道交易号、商户单号、金额、证据：证据写明来自哪天账单的对账）。
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { suite } from '../orders/kit.ts';
import { anomalies, tradeNo } from '../result/kit.ts';
import {
  BILL_DATE,
  CHANNELS,
  IN_DAY_EARLY,
  PREVIOUS_DAY,
  SUCCESS,
  closedOrder,
  diffs,
  lineOf,
  orderRefund,
  paidOrder,
  recon,
  refundLine,
  refundLineOf,
  snapshot,
  tradeLine,
  type DiffRow,
} from './kit.ts';

const s = suite();

/** From 2026-10-22 10:00 +08:00 (kit NOW) to 2026-10-23 01:00 +08:00: past midnight at +08:00. */
const PAST_MIDNIGHT_MS = 15 * 60 * 60_000;

function byId(rows: readonly DiffRow[]): DiffRow[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

it.each(CHANNELS)(
  '[AC-B2-15j#29] %s 退款行的差错（渠道有我方无、渠道成功我方 PROCESSING、金额不一致、我方 SUCCESS 账单缺行）登记后，时钟过了 +08:00 零点再跑同一账单日（至少一次投递）：不新增、不改已登记的差错单（period 仍是账单日），退款单与凭证不变',
  async (channel) => {
    const r = await recon(s);
    const order = await paidOrder(r, channel, { paidAt: PREVIOUS_DAY });
    const processing = await orderRefund(r, order, { status: 'PROCESSING', amountFen: 300n });
    const short = await orderRefund(r, order, { amountFen: 1_000n });
    const unlisted = await orderRefund(r, order, { amountFen: 100n, at: IN_DAY_EARLY });
    const outRefundNo = 'RNOTOURS0000000000000029';
    r.channels[channel].setBill(BILL_DATE, [
      refundLineOf(order, processing),
      refundLineOf(order, short, { amountFen: 900n }),
      refundLine({
        outTradeNo: order.out_trade_no,
        channelTradeNo: order.channel_trade_no ?? '',
        outRefundNo,
        channel,
        amountFen: 500n,
      }),
    ]);
    const before = await snapshot(r);
    await r.run(channel);
    const first = await diffs(r);
    expect(first.map((row) => row.ref_id).sort()).toEqual(
      [processing.id, short.id, unlisted.id, outRefundNo].sort(),
    );
    expect(first.map((row) => [row.type, row.source, row.period])).toEqual(
      first.map(() => ['pay_mismatch', 'R4', BILL_DATE]),
    );

    r.f.clock.advanceMs(PAST_MIDNIGHT_MS);
    await r.run(channel, BILL_DATE);
    // Same created_at for every diff of a run: compared in id order.
    expect(byId(await diffs(r))).toEqual(byId(first));
    expect(await snapshot(r)).toEqual(before);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15j#30] %s 对账登记的异常收款（CLOSED 单有收款、找不到我方支付单的商户单号有收款）的证据写明来源是对账（source recon）与账单日',
  async (channel) => {
    const r = await recon(s);
    const order = await closedOrder(r, channel);
    r.channels[channel].setBill(BILL_DATE, [
      lineOf(order, { channelTradeNo: tradeNo(channel) }),
      tradeLine({
        outTradeNo: 'PNOTOURS00000000000030',
        channelTradeNo: tradeNo(channel),
        amountFen: 990n,
        state: SUCCESS[channel],
      }),
    ]);
    await r.run(channel);
    const rows = await anomalies(r.f);
    expect(rows).toHaveLength(2);
    for (const anomaly of rows) {
      expect(anomaly.evidence, anomaly.channel_trade_no).toMatchObject({ source: 'recon' });
      expect(JSON.stringify(anomaly.evidence), anomaly.channel_trade_no).toContain(BILL_DATE);
    }
  },
  60_000,
);
