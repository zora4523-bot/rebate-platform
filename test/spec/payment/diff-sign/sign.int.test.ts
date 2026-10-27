// B2-15l diff sign rule tests (claude-independent, SPEC_REF 736d24c5): contracts/openapi.yaml
// AdminPayReconDiff (diff_fen = expected_fen − actual_fen); 08 BR-PAY-05 ④ (通知、查询或对账证明渠道侧
// 对一张 CLOSED 的单、或对一个找不到我方支付单的商户单号有收款时：登记异常收款……并生成差错单), BR-PAY-07
// (收款差错单来源 R4、类型 pay_mismatch / pay_anomaly). Rulings D10-358 ① / D10-360: a pay_anomaly diff
// is expected 0 (nothing of ours), actual the received amount, diff its negative, on both
// registration paths (B2-15c's registerAnomalyRow through a notification or a query; B2-15j's
// reconciliation); pay_mismatch keeps expected − actual; the admin list shows the same sign.
// Top-level it() only (规划/11 §4.3).
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import { fixture, seedOrder, suite, type Fixture, type OrderRow } from '../orders/kit.ts';
import {
  BILL_DATE,
  closedOrder,
  diffOf,
  diffView,
  diffs,
  diffsOf,
  expectDiff,
  lineOf,
  page,
  paidOrder,
  pendingOrder,
  recon,
  tradeLine,
  withReconAdmin,
  type DiffRow,
} from '../recon/kit.ts';
import {
  AMOUNT,
  CHANNELS,
  SUCCESS,
  acked,
  anomalies,
  jobKit,
  nacked,
  paidNotification,
  payJobHandler,
  reconDiffs,
  returnedQuery,
  specChannels,
  tradeNo,
  withNotify,
} from '../result/kit.ts';

const s = suite();

/** A CLOSED order of ours (the channel confirmed it closed), as B2-15c's tests seed it. */
function closedSeed(f: Fixture, channel: PayChannelCode): Promise<OrderRow> {
  return seedOrder(f, {
    pay_channel: channel,
    amount_fen: AMOUNT,
    status: 'CLOSED',
    closed_at: f.clock.now(),
    close_reason: 'expired',
    launch_issued_at: f.clock.now(),
  });
}

/** diff_fen is expected_fen − actual_fen (contract AdminPayReconDiff). */
function signed(row: DiffRow): void {
  expect(row.diff_fen, `${row.type} ${row.ref_id}`).toBe(row.expected_fen - row.actual_fen);
}

/**
 * The app's only anomaly receipt is `amountFen` and its one R4 pay_anomaly diff is expected 0,
 * actual the received amount, diff its negative.
 */
async function anomalyDiff(f: Fixture, amountFen: bigint): Promise<void> {
  const rows = await anomalies(f);
  expect(rows).toHaveLength(1);
  const anomaly = rows[0]!;
  expect(anomaly.amount_fen).toBe(amountFen);
  const found = (await reconDiffs(f)).filter((row) => row.ref_id === anomaly.id);
  expect(found).toHaveLength(1);
  const diff = found[0]!;
  expect(diff).toMatchObject({
    type: 'pay_anomaly',
    source: 'R4',
    ref_type: 'pay_anomaly',
    ref_id: anomaly.id,
    expected_fen: 0n,
    actual_fen: amountFen,
    diff_fen: -amountFen,
  });
  signed(diff);
}

it.each(CHANNELS)(
  '[AC-B2-15l#1] %s 通知登记的异常收款（CLOSED 单收到合格通知，B2-15c registerAnomalyRow）：R4 pay_anomaly 差错单 expected 0、actual = 收款额、diff = −收款额（expected − actual）',
  async (channel) => {
    const f = await fixture(s);
    const { channels, identity } = specChannels(f);
    const order = await closedSeed(f, channel);
    const trade = tradeNo(channel);
    const built = paidNotification(channels, identity[channel], order, { channelTradeNo: trade });
    await withNotify(f, channels, async (h) => {
      acked(channel, await h.deliver(channel, built.raw));
    });
    await anomalyDiff(f, AMOUNT);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15l#2] %s 通知登记的异常收款（商户单号找不到我方支付单，金额以通知为准 777 分）：差错单 expected 0、actual 777、diff −777',
  async (channel) => {
    const f = await fixture(s);
    const { channels, identity } = specChannels(f);
    const built = channels[channel].notification({
      identity: identity[channel],
      outTradeNo: `S${randomBytes(10).toString('hex').toUpperCase()}`,
      amountFen: 777n,
      state: SUCCESS[channel],
      channelTradeNo: tradeNo(channel),
    });
    await withNotify(f, channels, async (h) => {
      nacked(channel, await h.deliver(channel, built.raw));
    });
    await anomalyDiff(f, 777n);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15l#3] %s 查询登记的异常收款（CLOSED 单的 order.query 执行时渠道报已收款，B2-15c registerAnomalyRow）：差错单 expected 0、actual = 收款额、diff = −收款额',
  async (channel) => {
    const f = await fixture(s);
    const { channels, identity } = specChannels(f);
    const order = await closedSeed(f, channel);
    const trade = tradeNo(channel);
    channels[channel].setTrade(
      order.out_trade_no,
      channels[channel].paid(identity[channel], AMOUNT, trade),
    );
    f.clock.advanceMs(20_000);
    const kit = await jobKit(f, channels);
    const handle = await payJobHandler(kit);
    await handle(returnedQuery(order));
    expect(channels[channel].queried).toEqual([order.out_trade_no]);
    await anomalyDiff(f, AMOUNT);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15l#4] %s 对账登记的异常收款（B2-15j：账单证明 CLOSED 单有收款、账单商户单号找不到我方支付单 990 分）：两条 R4 pay_anomaly 差错单都是 expected 0、actual = 账单金额、diff = −账单金额',
  async (channel) => {
    const r = await recon(s);
    const order = await closedOrder(r, channel);
    const outTradeNo = 'PNOTOURS00000000000015';
    r.channels[channel].setBill(BILL_DATE, [
      lineOf(order, { channelTradeNo: tradeNo(channel) }),
      tradeLine({
        outTradeNo,
        channelTradeNo: tradeNo(channel),
        amountFen: 990n,
        state: SUCCESS[channel],
      }),
    ]);
    await r.run(channel);
    const rows = await anomalies(r.f);
    expect(rows).toHaveLength(2);
    const known = rows.find((row) => row.pay_order_id === order.id);
    const stray = rows.find((row) => row.out_trade_no === outTradeNo);
    expect(known, 'anomaly of the CLOSED order').toBeDefined();
    expect(stray, 'anomaly of the unknown out_trade_no').toBeDefined();
    expect(await diffs(r)).toHaveLength(2);
    expectDiff(r, (await diffsOf(r, known!.id))[0], {
      type: 'pay_anomaly',
      refType: 'pay_anomaly',
      refId: known!.id,
      expectedFen: 0n,
      actualFen: order.amount_fen,
      diffFen: -order.amount_fen,
    });
    expectDiff(r, (await diffsOf(r, stray!.id))[0], {
      type: 'pay_anomaly',
      refType: 'pay_anomaly',
      refId: stray!.id,
      expectedFen: 0n,
      actualFen: 990n,
      diffFen: -990n,
    });
  },
  60_000,
);

it('[AC-B2-15l#5] 同一账单里异常收款与 pay_mismatch 同一口径：CLOSED 单收款 (0, 12345, −12345)、PENDING 单有收款 (0, 12345, −12345)、金额不一致 (1900, 1899, 1)、PAID 缺行 (990, 0, 990)；每条差错单 diff = expected − actual', async () => {
  const r = await recon(s);
  const closed = await closedOrder(r, 'wechat_pay');
  const pending = await pendingOrder(r, 'wechat_pay');
  const short = await paidOrder(r, 'wechat_pay', { amountFen: 1_900n });
  const missing = await paidOrder(r, 'wechat_pay', { amountFen: 990n });
  r.channels.wechat_pay.setBill(BILL_DATE, [
    lineOf(closed, { channelTradeNo: tradeNo('wechat_pay') }),
    lineOf(pending),
    lineOf(short, { amountFen: 1_899n }),
  ]);
  await r.run('wechat_pay');
  const rows = await diffs(r);
  expect(rows).toHaveLength(4);
  for (const row of rows) signed(row);
  const found = await anomalies(r.f);
  expect(found).toHaveLength(1);
  const anomaly = found[0]!;
  expectDiff(r, (await diffsOf(r, anomaly.id))[0], {
    type: 'pay_anomaly',
    refType: 'pay_anomaly',
    refId: anomaly.id,
    expectedFen: 0n,
    actualFen: AMOUNT,
    diffFen: -AMOUNT,
  });
  expectDiff(r, (await diffsOf(r, pending.id))[0], {
    type: 'pay_mismatch',
    refType: 'pay_order',
    refId: pending.id,
    expectedFen: 0n,
    actualFen: AMOUNT,
    diffFen: -AMOUNT,
  });
  expectDiff(r, (await diffsOf(r, short.id))[0], {
    type: 'pay_mismatch',
    refType: 'pay_order',
    refId: short.id,
    expectedFen: 1_900n,
    actualFen: 1_899n,
    diffFen: 1n,
  });
  expectDiff(r, (await diffsOf(r, missing.id))[0], {
    type: 'pay_mismatch',
    refType: 'pay_order',
    refId: missing.id,
    expectedFen: 990n,
    actualFen: 0n,
    diffFen: 990n,
  });
}, 60_000);

it('[AC-B2-15l#6] 后台对账差错列表（listAdminPayReconDiffs）展示对账登记的差错单与库里同号：pay_anomaly 的 diff_fen = −收款额、pay_mismatch（PENDING 有收款）的 diff_fen = −收款额，每项 diff_fen = expected_fen − actual_fen', async () => {
  const r = await recon(s);
  const closed = await closedOrder(r, 'alipay');
  const pending = await pendingOrder(r, 'alipay');
  r.channels.alipay.setBill(BILL_DATE, [
    lineOf(closed, { channelTradeNo: tradeNo('alipay') }),
    lineOf(pending),
  ]);
  await r.run('alipay');
  const rows = await diffs(r);
  expect(rows).toHaveLength(2);
  await withReconAdmin(r.f, async (h) => {
    const data = await page(await h.list());
    expect(data.total).toBe(2);
    for (const item of data.items) {
      expect(item['diff_fen'], JSON.stringify(item)).toBe(
        Number(item['expected_fen']) - Number(item['actual_fen']),
      );
    }
    const anomalyItem = data.items.find((item) => item['type'] === 'pay_anomaly');
    expect(anomalyItem).toMatchObject({
      expected_fen: 0,
      actual_fen: Number(AMOUNT),
      diff_fen: -Number(AMOUNT),
    });
    const mismatchItem = data.items.find((item) => item['ref_id'] === pending.id);
    expect(mismatchItem).toMatchObject({
      type: 'pay_mismatch',
      expected_fen: 0,
      actual_fen: Number(AMOUNT),
      diff_fen: -Number(AMOUNT),
    });
    const byId = new Map(rows.map((row) => [row.id, diffView(row)]));
    for (const item of data.items) {
      expect(diffOf(item)).toEqual(byId.get(String(item['recon_diff_id'])));
    }
  });
}, 60_000);

it('[AC-B2-15l#7] 后台对账差错列表展示通知登记的异常收款差错单：expected_fen 0、actual_fen = 收款额、diff_fen = −收款额', async () => {
  const f = await fixture(s);
  const { channels, identity } = specChannels(f);
  const order = await closedSeed(f, 'wechat_pay');
  const built = paidNotification(channels, identity.wechat_pay, order, {
    channelTradeNo: tradeNo('wechat_pay'),
  });
  await withNotify(f, channels, async (h) => {
    acked('wechat_pay', await h.deliver('wechat_pay', built.raw));
  });
  const rows = await reconDiffs(f);
  expect(rows).toHaveLength(1);
  await withReconAdmin(f, async (h) => {
    const data = await page(await h.list({ type: 'pay_anomaly' }));
    expect(data.total).toBe(1);
    expect(data.items[0]).toMatchObject({
      recon_diff_id: rows[0]!.id,
      type: 'pay_anomaly',
      expected_fen: 0,
      actual_fen: Number(AMOUNT),
      diff_fen: -Number(AMOUNT),
    });
  });
}, 60_000);
