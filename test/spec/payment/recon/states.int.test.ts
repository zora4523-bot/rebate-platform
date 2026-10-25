// B2-15j bill-state rule tests (claude-independent, SPEC_REF 736d24c5; rule-test review r1): 08 BR-PAY-07
// （按 out_trade_no / out_refund_no 逐笔核对金额与状态：渠道「有收款」只认 pay.<pay_channel>.success_states
// 的交易行，退款「渠道已退」只认 refund_success_states 的退款行），BR-PAY-05 ④（只有渠道侧对 CLOSED 单或
// 找不到的商户单号「有收款」才登记异常收款），BR-PAY-04 细则（状态清单缺省只含官方成功状态；照 [AC-B2-15c#14]
// 「状态不是成功的不登记」）。Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import { suite } from '../orders/kit.ts';
import { CLOSED_STATE, NOT_LISTED } from '../refund/kit.ts';
import { NOT_PAID, tradeNo } from '../result/kit.ts';
import {
  AMOUNT,
  BILL_DATE,
  CHANNELS,
  NOT_SUCCESS,
  PREVIOUS_DAY,
  alerted,
  closedOrder,
  diffs,
  expectDiff,
  lineOf,
  noFulfilment,
  orderRefund,
  paidOrder,
  pendingOrder,
  recon,
  refundLineOf,
  snapshot,
  tradeLine,
  userTraces,
} from './kit.ts';

const s = suite();

it.each(CHANNELS)(
  '[AC-B2-15j#26] %s 账单交易行的渠道状态不在 success_states（微信 CLOSED / NOTPAY、支付宝 TRADE_CLOSED / WAIT_BUYER_PAY）不算渠道有收款：CLOSED 单、PENDING 单与找不到我方支付单的商户单号都不登记异常收款、不写 PAY_ANOMALY、不生成差错单；同一账单里当天 PAID 而缺行的单照常报差错',
  async (channel) => {
    const r = await recon(s);
    const closed = await closedOrder(r, channel);
    const pending = await pendingOrder(r, channel);
    // Paid inside the bill day and absent from the bill: proves the bill was reconciled at all.
    const missing = await paidOrder(r, channel);
    r.channels[channel].setBill(BILL_DATE, [
      lineOf(closed, { channelTradeNo: tradeNo(channel), state: NOT_SUCCESS[channel] }),
      lineOf(pending, { channelTradeNo: tradeNo(channel), state: NOT_PAID[channel] }),
      tradeLine({
        outTradeNo: 'PNOTOURS00000000000026',
        channelTradeNo: tradeNo(channel),
        amountFen: 990n,
        state: NOT_SUCCESS[channel],
      }),
      tradeLine({
        outTradeNo: 'PNOTOURS00000000000027',
        channelTradeNo: tradeNo(channel),
        amountFen: 1_900n,
        state: NOT_PAID[channel],
      }),
    ]);
    const before = await snapshot(r);
    await r.run(channel);
    // No anomaly receipt, no PAY_ANOMALY, orders unchanged (the CLOSED one stays CLOSED).
    expect(await snapshot(r)).toEqual(before);
    const rows = await diffs(r);
    expect(rows).toHaveLength(1);
    expectDiff(r, rows[0], {
      type: 'pay_mismatch',
      refType: 'pay_order',
      refId: missing.id,
      expectedFen: AMOUNT,
      actualFen: 0n,
    });
    noFulfilment(r);
    expect(await userTraces(r.f)).toEqual({ user_accounts: 0, balances: 0, user_entries: 0 });
  },
  60_000,
);

const REFUND_NOT_SUCCESS: [PayChannelCode, string][] = CHANNELS.flatMap(
  (channel): [PayChannelCode, string][] => [
    [channel, CLOSED_STATE[channel]],
    [channel, NOT_LISTED[channel]],
  ],
);

it.each(REFUND_NOT_SUCCESS)(
  '[AC-B2-15j#27] %s 我方退款 SUCCESS 1000 分、账单同号退款行金额相同但渠道状态 %s 不在 refund_success_states（钱没有退出去）→ 恰一条 R4 pay_mismatch（ref pay_refund、expected 为退款金额）并告警；退款单、refunded_fen 与凭证不改',
  async (channel, state) => {
    const r = await recon(s);
    const order = await paidOrder(r, channel, { paidAt: PREVIOUS_DAY });
    const refund = await orderRefund(r, order, { amountFen: 1_000n });
    r.channels[channel].setBill(BILL_DATE, [refundLineOf(order, refund, { state })]);
    const before = await snapshot(r);
    await r.run(channel);
    const rows = await diffs(r);
    expect(rows).toHaveLength(1);
    expectDiff(r, rows[0], {
      type: 'pay_mismatch',
      refType: 'pay_refund',
      refId: refund.id,
      expectedFen: 1_000n,
      actualFen: null,
    });
    expect(await snapshot(r)).toEqual(before);
    alerted(r, [refund.id, refund.out_refund_no]);
    noFulfilment(r);
  },
  60_000,
);
