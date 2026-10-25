// B2-15j anomaly rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-05 ④（通知、查询或对账证明
// 渠道侧对一张 CLOSED 的单、或对一个找不到我方支付单的商户单号有收款时：登记一条异常收款（渠道、渠道交易号、
// 商户单号、金额、证据），写异常收款分录，不触发任何业务开通，告警并生成差错单；CLOSED 的单不得再变为 PAID），
// BR-PAY-07（PAY_ANOMALY 借 CASH_PAY:{pay_channel} / 贷 PAY_SUSPENSE；每条异常收款的收款凭证至多一张；
// 收款差错单来源 R4、类型 pay_anomaly）；contracts/openapi.yaml AdminPayReconDiff（period 为账单日）。
// The diff amounts follow B2-15c's anomaly registration (expected 0, actual and diff the received
// amount; test/spec/payment/result/closed-query.int.test.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { payOrder, payOrders, suite } from '../orders/kit.ts';
import { anomalies, anomalyVoucherOf, tradeNo, vouchers } from '../result/kit.ts';
import {
  BILL_DATE,
  CHANNELS,
  SUCCESS,
  alerted,
  closedOrder,
  diffs,
  diffsOf,
  expectDiff,
  lineOf,
  noFulfilment,
  recon,
  registeredAnomaly,
  snapshot,
  tradeLine,
  userTraces,
} from './kit.ts';

const s = suite();

it.each(CHANNELS)(
  '[AC-B2-15j#13] %s 账单证明渠道对一张 CLOSED 单有收款 → 登记一条异常收款（渠道、账单的渠道交易号、商户单号、该 CLOSED 单、账单金额，open）+ PAY_ANOMALY（借 CASH_PAY / 贷 PAY_SUSPENSE）+ R4 pay_anomaly 差错单（period 为账单日）+ 告警；CLOSED 单不变为 PAID、不写收款凭证、不开通',
  async (channel) => {
    const r = await recon(s);
    const order = await closedOrder(r, channel);
    const trade = tradeNo(channel);
    r.channels[channel].setBill(BILL_DATE, [lineOf(order, { channelTradeNo: trade })]);
    await r.run(channel);
    expect(await payOrder(r.f, order.id)).toEqual(order);
    const rows = await anomalies(r.f);
    expect(rows).toHaveLength(1);
    const anomaly = rows[0]!;
    expect(anomaly).toMatchObject({
      app_id: r.f.subject.app_id,
      pay_channel: channel,
      channel_trade_no: trade,
      out_trade_no: order.out_trade_no,
      pay_order_id: order.id,
      amount_fen: order.amount_fen,
      refunded_fen: 0n,
      status: 'open',
    });
    expect(await vouchers(r.f)).toEqual([anomalyVoucherOf(anomaly)]);
    const found = await diffs(r);
    expect(found).toHaveLength(1);
    expectDiff(r, found[0], {
      type: 'pay_anomaly',
      refType: 'pay_anomaly',
      refId: anomaly.id,
      expectedFen: 0n,
      actualFen: order.amount_fen,
      diffFen: order.amount_fen,
    });
    alerted(r, [anomaly.id]);
    noFulfilment(r);
    expect(await userTraces(r.f)).toEqual({ user_accounts: 0, balances: 0, user_entries: 0 });
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15j#14] %s 账单里的商户单号找不到我方支付单 → 登记异常收款（out_trade_no 为该单号、pay_order_id 为空、账单金额）+ PAY_ANOMALY + R4 pay_anomaly 差错单 + 告警；不新建支付单、不开通',
  async (channel) => {
    const r = await recon(s);
    const outTradeNo = 'PNOTOURS00000000000001';
    const trade = tradeNo(channel);
    r.channels[channel].setBill(BILL_DATE, [
      tradeLine({ outTradeNo, channelTradeNo: trade, amountFen: 990n, state: SUCCESS[channel] }),
    ]);
    await r.run(channel);
    expect(await payOrders(r.f)).toEqual([]);
    const rows = await anomalies(r.f);
    expect(rows).toHaveLength(1);
    const anomaly = rows[0]!;
    expect(anomaly).toMatchObject({
      pay_channel: channel,
      channel_trade_no: trade,
      out_trade_no: outTradeNo,
      pay_order_id: null,
      amount_fen: 990n,
      refunded_fen: 0n,
      status: 'open',
    });
    expect(await vouchers(r.f)).toEqual([anomalyVoucherOf(anomaly)]);
    expectDiff(r, (await diffsOf(r, anomaly.id))[0], {
      type: 'pay_anomaly',
      refType: 'pay_anomaly',
      refId: anomaly.id,
      expectedFen: 0n,
      actualFen: 990n,
      diffFen: 990n,
    });
    expect(await diffs(r)).toHaveLength(1);
    alerted(r, [anomaly.id]);
    noFulfilment(r);
  },
  60_000,
);

it('[AC-B2-15j#15] 通知或查询已登记过的异常收款（同渠道交易号）出现在账单里：不重复登记、不再写 PAY_ANOMALY、不再生成差错单', async () => {
  const r = await recon(s);
  const order = await closedOrder(r, 'wechat_pay');
  const trade = tradeNo('wechat_pay');
  await registeredAnomaly(r, order, { channelTradeNo: trade });
  r.channels.wechat_pay.setBill(BILL_DATE, [lineOf(order, { channelTradeNo: trade })]);
  const before = await snapshot(r);
  await r.run('wechat_pay');
  expect(await snapshot(r)).toEqual(before);
  expect(await diffs(r)).toEqual([]);
  noFulfilment(r);
}, 60_000);

it('[AC-B2-15j#16] 同一账单日重跑（至少一次投递）：CLOSED 单的收款与找不到支付单的收款各只登记一条异常收款、一张 PAY_ANOMALY、一条差错单', async () => {
  const r = await recon(s);
  const order = await closedOrder(r, 'alipay');
  const known = tradeNo('alipay');
  const stray = tradeNo('alipay');
  r.channels.alipay.setBill(BILL_DATE, [
    lineOf(order, { channelTradeNo: known }),
    tradeLine({
      outTradeNo: 'PNOTOURS00000000000002',
      channelTradeNo: stray,
      amountFen: 1_900n,
      state: SUCCESS.alipay,
    }),
  ]);
  await r.run('alipay');
  const first = { anomalies: await anomalies(r.f), vouchers: await vouchers(r.f) };
  const firstDiffs = await diffs(r);
  expect(first.anomalies.map((row) => row.channel_trade_no).sort()).toEqual([known, stray].sort());
  expect(first.vouchers).toHaveLength(2);
  expect(firstDiffs).toHaveLength(2);
  for (const anomaly of first.anomalies) {
    expect(first.vouchers).toContainEqual(anomalyVoucherOf(anomaly));
    expect(firstDiffs.map((row) => row.ref_id)).toContain(anomaly.id);
  }

  r.f.clock.advanceMs(60 * 60_000);
  await r.run('alipay');
  expect(await anomalies(r.f)).toEqual(first.anomalies);
  expect(await vouchers(r.f)).toEqual(first.vouchers);
  expect(await diffs(r)).toEqual(firstDiffs);
}, 60_000);
