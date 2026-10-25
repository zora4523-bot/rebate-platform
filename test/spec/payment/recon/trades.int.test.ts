// B2-15j trade-line rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07（每日 T+1 用渠道的
// 交易账单按 out_trade_no 逐笔核对金额与状态：渠道有而我方不是 PAID、我方 PAID 而渠道没有、金额不一致，
// 都生成差错单并告警；已是终态的支付单不改状态，更正经差错单处理；收款差错单来源 R4、类型 pay_mismatch），
// BR-PAY-04（支付成功只认验签通过的通知与主动查询：账单不是 PO2 的依据）。账单日是 +08:00 会计日。
// The reconciliation runs through apps/api/src/modules/payment/application/pay-recon.ts (kit.ts).
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { suite } from '../orders/kit.ts';
import {
  AMOUNT,
  BILL_DATE,
  CHANNELS,
  IN_DAY_EARLY,
  NEXT_DAY,
  NOT_SUCCESS,
  PREVIOUS_DAY,
  alerted,
  diffs,
  diffsOf,
  expectDiff,
  lineOf,
  noFulfilment,
  paidOrder,
  pendingOrder,
  recon,
  settled,
  snapshot,
} from './kit.ts';

const s = suite();

function otherOf(channel: (typeof CHANNELS)[number]) {
  return channel === 'wechat_pay' ? 'alipay' : 'wechat_pay';
}

it.each(CHANNELS)(
  '[AC-B2-15j#1] %s 账单与我方一致：每行的 out_trade_no 对上一张 PAID 单、金额相等、状态为成功 → 不生成差错单，支付单、收款凭证原样，不开通；只下载该渠道 bill_date 当天的账单，另一渠道的 PAID 单不参与本次核对',
  async (channel) => {
    const r = await recon(s);
    const a = await paidOrder(r, channel);
    const b = await paidOrder(r, channel, { paidAt: IN_DAY_EARLY, amountFen: 990n });
    await paidOrder(r, otherOf(channel));
    r.channels[channel].setBill(BILL_DATE, [lineOf(a), lineOf(b)]);
    const before = await snapshot(r);
    await r.run(channel);
    expect(r.channels[channel].billDates).toEqual([BILL_DATE]);
    expect(r.channels[otherOf(channel)].billDates).toEqual([]);
    expect(await diffs(r)).toEqual([]);
    expect(await snapshot(r)).toEqual(before);
    noFulfilment(r);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15j#2] %s 渠道有收款、我方单仍是 PENDING → 一条 R4 pay_mismatch（ref pay_order、我方 0、渠道为账单金额、diff = expected − actual）并告警；支付单仍是 PENDING、不写收款凭证、不开通、不登记异常收款（账单不是 PO2 的依据）',
  async (channel) => {
    const r = await recon(s);
    const order = await pendingOrder(r, channel);
    r.channels[channel].setBill(BILL_DATE, [lineOf(order)]);
    const before = await snapshot(r);
    await r.run(channel);
    const rows = await diffs(r);
    expect(rows).toHaveLength(1);
    expectDiff(r, rows[0], {
      type: 'pay_mismatch',
      refType: 'pay_order',
      refId: order.id,
      expectedFen: 0n,
      actualFen: AMOUNT,
    });
    expect(await snapshot(r)).toEqual(before);
    alerted(r, [order.id, order.out_trade_no]);
    noFulfilment(r);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15j#3] %s 我方 PAID（paid_at 在账单日 +08:00 当天）而渠道账单没有 → 一条 pay_mismatch（我方 amount_fen、渠道 0）并告警，支付单仍是 PAID、收款凭证不冲回；+08:00 前一天、后一天支付的单（含 UTC 同日的次日凌晨）不算账单日的单',
  async (channel) => {
    const r = await recon(s);
    const inDay = await paidOrder(r, channel, { paidAt: IN_DAY_EARLY });
    await paidOrder(r, channel, { paidAt: NEXT_DAY });
    await paidOrder(r, channel, { paidAt: PREVIOUS_DAY });
    const listed = await paidOrder(r, channel);
    r.channels[channel].setBill(BILL_DATE, [lineOf(listed)]);
    const before = await snapshot(r);
    await r.run(channel);
    const rows = await diffs(r);
    expect(rows).toHaveLength(1);
    expectDiff(r, rows[0], {
      type: 'pay_mismatch',
      refType: 'pay_order',
      refId: inDay.id,
      expectedFen: AMOUNT,
      actualFen: 0n,
    });
    expect(await snapshot(r)).toEqual(before);
    alerted(r, [inDay.id, inDay.out_trade_no]);
    noFulfilment(r);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15j#4] %s 金额不一致：PAID 12345 分、账单 12300 分 → 一条 pay_mismatch（expected 12345、actual 12300、diff 45）并告警；支付单与收款凭证不改、不补记差额',
  async (channel) => {
    const r = await recon(s);
    const order = await paidOrder(r, channel);
    r.channels[channel].setBill(BILL_DATE, [lineOf(order, { amountFen: AMOUNT - 45n })]);
    const before = await snapshot(r);
    await r.run(channel);
    const rows = await diffs(r);
    expect(rows).toHaveLength(1);
    expectDiff(r, rows[0], {
      type: 'pay_mismatch',
      refType: 'pay_order',
      refId: order.id,
      expectedFen: AMOUNT,
      actualFen: AMOUNT - 45n,
      diffFen: 45n,
    });
    expect(await snapshot(r)).toEqual(before);
    alerted(r, [order.id, order.out_trade_no]);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15j#5] %s 状态不一致：我方 PAID、账单同号行的渠道状态不在 success_states（微信 CLOSED / 支付宝 TRADE_CLOSED）→ 一条 pay_mismatch（ref 该支付单、我方 amount_fen）并告警；PAID 单不改为别的状态',
  async (channel) => {
    const r = await recon(s);
    const order = await paidOrder(r, channel);
    r.channels[channel].setBill(BILL_DATE, [lineOf(order, { state: NOT_SUCCESS[channel] })]);
    const before = await snapshot(r);
    await r.run(channel);
    const rows = await diffs(r);
    expect(rows).toHaveLength(1);
    expectDiff(r, rows[0], {
      type: 'pay_mismatch',
      refType: 'pay_order',
      refId: order.id,
      expectedFen: AMOUNT,
      actualFen: null,
    });
    expect(await snapshot(r)).toEqual(before);
    alerted(r, [order.id, order.out_trade_no]);
  },
  60_000,
);

it('[AC-B2-15j#6] 逐笔核对、一笔一单：一致、PENDING 有收款、PAID 缺行、金额不一致混在同一账单 → 恰三条差错单各指一张支付单；同一账单日重跑（至少一次投递）不新增差错单、不改已登记的差错单，支付单与凭证始终不变', async () => {
  const r = await recon(s);
  const ok = await paidOrder(r, 'wechat_pay');
  const pending = await pendingOrder(r, 'wechat_pay');
  const missing = await paidOrder(r, 'wechat_pay', { amountFen: 990n });
  const short = await paidOrder(r, 'wechat_pay', { amountFen: 1_900n });
  r.channels.wechat_pay.setBill(BILL_DATE, [
    lineOf(ok),
    lineOf(pending),
    lineOf(short, { amountFen: 1_899n }),
  ]);
  const before = await snapshot(r);
  await r.run('wechat_pay');
  const first = await diffs(r);
  expect(first).toHaveLength(3);
  expectDiff(r, (await diffsOf(r, pending.id))[0], {
    type: 'pay_mismatch',
    refType: 'pay_order',
    refId: pending.id,
    expectedFen: 0n,
    actualFen: AMOUNT,
  });
  expectDiff(r, (await diffsOf(r, missing.id))[0], {
    type: 'pay_mismatch',
    refType: 'pay_order',
    refId: missing.id,
    expectedFen: 990n,
    actualFen: 0n,
  });
  expectDiff(r, (await diffsOf(r, short.id))[0], {
    type: 'pay_mismatch',
    refType: 'pay_order',
    refId: short.id,
    expectedFen: 1_900n,
    actualFen: 1_899n,
    diffFen: 1n,
  });
  expect(await diffsOf(r, ok.id)).toEqual([]);

  r.f.clock.advanceMs(60 * 60_000);
  await r.run('wechat_pay');
  expect(await diffs(r)).toEqual(first);
  expect(await snapshot(r)).toEqual(before);
  noFulfilment(r);
}, 60_000);

it('[AC-B2-15j#7] 账单未就绪（downloadBill 未知结果）不当作空账单：不生成任何差错单、不改任何数据（是否抛错由实现定，任务可重试）；账单出来后再跑，当天 PAID 而账单没有的单才报差错', async () => {
  const r = await recon(s);
  const missing = await paidOrder(r, 'alipay');
  r.channels.alipay.setBill(BILL_DATE, 'unknown');
  const before = await snapshot(r);
  await settled(r.run('alipay'));
  expect(r.channels.alipay.billDates).toContain(BILL_DATE);
  expect(await diffs(r)).toEqual([]);
  expect(await snapshot(r)).toEqual(before);

  r.channels.alipay.setBill(BILL_DATE, []);
  await r.run('alipay');
  const rows = await diffs(r);
  expect(rows).toHaveLength(1);
  expectDiff(r, rows[0], {
    type: 'pay_mismatch',
    refType: 'pay_order',
    refId: missing.id,
    expectedFen: AMOUNT,
    actualFen: 0n,
  });
  expect(await snapshot(r)).toEqual(before);
}, 60_000);
