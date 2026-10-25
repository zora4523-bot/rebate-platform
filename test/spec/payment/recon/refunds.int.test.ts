// B2-15j refund-line rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07（按 out_refund_no
// 逐笔核对金额与状态，退款不一致生成差错单并告警；更正经差错单处理），BR-PAY-06 ④⑤（退款结果只认验签通过的
// 退款通知或主动查询：对账不改退款单状态、不写 PAY_REFUND、不动 refunded_fen）。账单日是 +08:00 会计日。
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { suite } from '../orders/kit.ts';
import {
  BILL_DATE,
  CHANNELS,
  IN_DAY_EARLY,
  NEXT_DAY,
  PREVIOUS_DAY,
  alerted,
  anomalyRefund,
  closedOrder,
  diffs,
  diffsOf,
  expectDiff,
  noFulfilment,
  orderRefund,
  paidOrder,
  recon,
  refundLine,
  refundLineOf,
  registeredAnomaly,
  snapshot,
} from './kit.ts';

const s = suite();

it.each(CHANNELS)(
  '[AC-B2-15j#8] %s 退款与我方一致：支付单的 SUCCESS 退款与异常收款的 SUCCESS 退款各有一行退款记录（out_refund_no、金额相等、退款成功状态）→ 不生成差错单，退款单、refunded_fen 与凭证原样',
  async (channel) => {
    const r = await recon(s);
    // Paid the day before: its trade line belongs to the previous bill.
    const order = await paidOrder(r, channel, { paidAt: PREVIOUS_DAY });
    const refund = await orderRefund(r, order, { amountFen: 1_000n });
    const closed = await closedOrder(r, channel);
    const anomaly = await registeredAnomaly(r, closed);
    const back = await anomalyRefund(r, anomaly);
    r.channels[channel].setBill(BILL_DATE, [
      refundLineOf(order, refund),
      refundLine({
        outTradeNo: closed.out_trade_no,
        channelTradeNo: anomaly.channel_trade_no,
        outRefundNo: back.out_refund_no,
        channel,
        amountFen: back.amount_fen,
      }),
    ]);
    const before = await snapshot(r);
    await r.run(channel);
    expect(await diffs(r)).toEqual([]);
    expect(await snapshot(r)).toEqual(before);
    noFulfilment(r);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15j#9] %s 渠道有退款而我方没有这个退款单号 → 一条 R4 pay_mismatch（ref_id 为该 out_refund_no、我方 0、渠道为退款金额）并告警；不新建退款单、不写凭证',
  async (channel) => {
    const r = await recon(s);
    const order = await paidOrder(r, channel, { paidAt: PREVIOUS_DAY });
    const outRefundNo = 'RNOTOURS0000000000000001';
    r.channels[channel].setBill(BILL_DATE, [
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
    const rows = await diffs(r);
    expect(rows).toHaveLength(1);
    expectDiff(r, rows[0], {
      type: 'pay_mismatch',
      refType: null,
      refId: outRefundNo,
      expectedFen: 0n,
      actualFen: 500n,
    });
    expect(await snapshot(r)).toEqual(before);
    alerted(r, [outRefundNo]);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15j#10] %s 渠道退款成功、我方退款单仍是 PROCESSING 或已 FAILED → 各一条 pay_mismatch（ref pay_refund、我方 0、渠道为退款金额）并告警；退款单状态不被对账改写，不写 PAY_REFUND、refunded_fen 不变',
  async (channel) => {
    const r = await recon(s);
    const order = await paidOrder(r, channel, { paidAt: PREVIOUS_DAY });
    const processing = await orderRefund(r, order, { status: 'PROCESSING', amountFen: 300n });
    const failed = await orderRefund(r, order, { status: 'FAILED', amountFen: 200n });
    r.channels[channel].setBill(BILL_DATE, [
      refundLineOf(order, processing),
      refundLineOf(order, failed),
    ]);
    const before = await snapshot(r);
    await r.run(channel);
    expect(await diffs(r)).toHaveLength(2);
    for (const refund of [processing, failed]) {
      expectDiff(r, (await diffsOf(r, refund.id))[0], {
        type: 'pay_mismatch',
        refType: 'pay_refund',
        refId: refund.id,
        expectedFen: 0n,
        actualFen: refund.amount_fen,
      });
      alerted(r, [refund.id, refund.out_refund_no]);
    }
    expect(await snapshot(r)).toEqual(before);
    noFulfilment(r);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15j#11] %s 退款金额不一致：我方 SUCCESS 1000 分、账单 900 分 → 一条 pay_mismatch（expected 1000、actual 900、diff 100）并告警；退款单与凭证不改',
  async (channel) => {
    const r = await recon(s);
    const order = await paidOrder(r, channel, { paidAt: PREVIOUS_DAY });
    const refund = await orderRefund(r, order, { amountFen: 1_000n });
    r.channels[channel].setBill(BILL_DATE, [refundLineOf(order, refund, { amountFen: 900n })]);
    const before = await snapshot(r);
    await r.run(channel);
    const rows = await diffs(r);
    expect(rows).toHaveLength(1);
    expectDiff(r, rows[0], {
      type: 'pay_mismatch',
      refType: 'pay_refund',
      refId: refund.id,
      expectedFen: 1_000n,
      actualFen: 900n,
      diffFen: 100n,
    });
    expect(await snapshot(r)).toEqual(before);
    alerted(r, [refund.id, refund.out_refund_no]);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15j#12] %s 我方退款 SUCCESS（succeeded_at 在账单日 +08:00 当天）而账单没有这笔退款 → 一条 pay_mismatch（我方退款金额、渠道 0）并告警；前一天、后一天（含 UTC 同日的次日凌晨）成功的退款不算账单日的',
  async (channel) => {
    const r = await recon(s);
    const order = await paidOrder(r, channel, { paidAt: PREVIOUS_DAY });
    const inDay = await orderRefund(r, order, { amountFen: 100n, at: IN_DAY_EARLY });
    await orderRefund(r, order, { amountFen: 200n, at: NEXT_DAY });
    await orderRefund(r, order, { amountFen: 300n, at: PREVIOUS_DAY });
    r.channels[channel].setBill(BILL_DATE, []);
    const before = await snapshot(r);
    await r.run(channel);
    const rows = await diffs(r);
    expect(rows).toHaveLength(1);
    expectDiff(r, rows[0], {
      type: 'pay_mismatch',
      refType: 'pay_refund',
      refId: inDay.id,
      expectedFen: 100n,
      actualFen: 0n,
    });
    expect(await snapshot(r)).toEqual(before);
    alerted(r, [inDay.id, inDay.out_refund_no]);
  },
  60_000,
);
