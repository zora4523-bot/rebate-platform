// B2-15c anomaly receipts found by a query, round 2 (claude-independent, SPEC_REF ec81e625): 08
// BR-PAY-05 ④ (通知、查询或对账证明渠道侧对一张 CLOSED 的单有收款时：登记异常收款、写 PAY_ANOMALY、
// 不触发开通、告警并生成差错单；CLOSED 的单不得再变为 PAID), BR-PAY-04 (主动查询走同一处理器；查询是
// 持久化的队列任务), BR-PAY-07 (PAY_ANOMALY 借 CASH_PAY:{pay_channel} / 贷 PAY_SUSPENSE); task §9.5,
// §9.6. Rule-test review r1 S1 (query.int.test.ts is frozen at the spec commit, so this is a file
// of its own): an order closed after its query job was enqueued (the user cancelled, B2-15d
// closed it) and a channel that, when the job runs, reports the money received.
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  createBody,
  enable,
  fixture,
  payOrder,
  seedOrder,
  success,
  suite,
  withHttp,
  type Fixture,
  type OrderRow,
} from '../orders/kit.ts';
import {
  AMOUNT,
  CHANNELS,
  alertsMentioning,
  anomalies,
  anomalyVoucherOf,
  attemptsOf,
  jobKit,
  payJobHandler,
  queuedByKey,
  received,
  reconDiffs,
  returnedQuery,
  sends,
  specChannels,
  tradeNo,
  untouched,
  userTraces,
  vouchers,
  type JobKit,
} from './kit.ts';

const s = suite();

/**
 * The CLOSED order's receipt and nothing else: the order still CLOSED and unpaid, exactly one
 * open anomaly with its PAY_ANOMALY voucher and R4 recon diff of the accounting date, an alert
 * naming the anomaly, no fulfilment job, no event, no user-side ledger trace.
 */
async function onlyAnomaly(
  f: Fixture,
  kit: JobKit,
  order: OrderRow,
  trade: string,
  period: string,
) {
  expect(await payOrder(f, order.id)).toMatchObject({
    ...untouched(order),
    status: 'CLOSED',
    paid_at: null,
  });
  const rows = await anomalies(f);
  expect(rows).toHaveLength(1);
  const anomaly = rows[0]!;
  expect(anomaly).toMatchObject({
    app_id: f.subject.app_id,
    pay_channel: order.pay_channel,
    channel_trade_no: trade,
    out_trade_no: order.out_trade_no,
    pay_order_id: order.id,
    amount_fen: order.amount_fen,
    refunded_fen: 0n,
    status: 'open',
  });
  expect(await vouchers(f)).toEqual([anomalyVoucherOf(anomaly)]);
  const diffs = await reconDiffs(f);
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toMatchObject({
    type: 'pay_anomaly',
    source: 'R4',
    period,
    ref_type: 'pay_anomaly',
    ref_id: anomaly.id,
    expected_fen: 0n,
    actual_fen: order.amount_fen,
    diff_fen: -order.amount_fen,
    status: 'open',
  });
  expect(alertsMentioning(kit.logs, [anomaly.id]).length).toBeGreaterThanOrEqual(1);
  expect(sends(kit, 'biz.reconcile')).toEqual([]);
  expect(kit.published).toEqual([]);
  expect(await userTraces(f)).toEqual({ user_accounts: 0, balances: 0, user_entries: 0 });
  return anomaly;
}

it.each(CHANNELS)(
  '[AC-B2-15c#33] %s 支付单已 CLOSED、之前入队的 order.query 执行时渠道报已收款且金额相等：不迁移；登记异常收款 + PAY_ANOMALY（借 CASH_PAY / 贷 PAY_SUSPENSE）+ 差错单 R4 pay_anomaly（会计日 +08:00）+ 告警，不开通、无事件，记录查询尝试；再查一次不重复登记',
  async (channel) => {
    // 17:30Z is 01:30 the next day at +08:00: the period is the accounting date.
    const f = await fixture(s, '2026-10-22T17:30:00.000Z');
    const { channels, identity } = specChannels(f);
    const order = await seedOrder(f, {
      pay_channel: channel,
      amount_fen: AMOUNT,
      status: 'CLOSED',
      closed_at: f.clock.now(),
      close_reason: 'user_cancel',
      launch_issued_at: f.clock.now(),
    });
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
    const anomaly = await onlyAnomaly(f, kit, order, trade, '2026-10-23');
    const attempts = await attemptsOf(f, order.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ kind: 'query', pay_refund_id: null });

    f.clock.advanceMs(20_000);
    await handle(returnedQuery(order));
    expect(channels[channel].queried).toEqual([order.out_trade_no, order.out_trade_no]);
    expect((await onlyAnomaly(f, kit, order, trade, '2026-10-23')).id).toBe(anomaly.id);
    expect(await attemptsOf(f, order.id)).toHaveLength(2);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15c#34] %s 下单时入队的首次定时查询在该单被关闭之后才执行、渠道报已收款：同样登记异常收款，不迁移、不开通，也不再入队下一档查询或关单任务',
  async (channel) => {
    const f = await fixture(s);
    await enable(f);
    let id = '';
    await withHttp(f, async (send) => {
      const data = await success(await send('create', { body: createBody(randomUUID(), channel) }));
      id = String(data['pay_order_id']);
    });
    const scheduled = (await queuedByKey(f, `order.query:${id}:`)).filter(
      (job) => job.singleton_key !== `order.query:${id}:returned`,
    );
    expect(
      scheduled.map((job) => job.job),
      'the first scheduled query',
    ).toEqual(['order.query']);
    const first = scheduled[0]!;
    expect(first.payload).not.toBeNull();

    // Closed meanwhile, as the close flow leaves it (BR-PAY-05 ②: the channel confirmed closed).
    f.clock.advanceMs(5_000);
    await f.db
      .updateTable('pay_orders')
      .set({
        status: 'CLOSED',
        closed_at: f.clock.now(),
        close_reason: 'user_cancel',
        closing: false,
        updated_at: f.clock.now(),
      })
      .where('app_id', '=', f.subject.app_id)
      .where('id', '=', id)
      .execute();
    const order = await payOrder(f, id);
    expect(order.status).toBe('CLOSED');

    const { channels, identity } = specChannels(f);
    const trade = tradeNo(channel);
    channels[channel].setTrade(
      order.out_trade_no,
      channels[channel].paid(identity[channel], order.amount_fen, trade),
    );
    const kit = await jobKit(f, channels);
    const handle = await payJobHandler(kit);
    f.clock.set(new Date(order.created_at.getTime() + 10_000));
    await handle(received('order.query', first.payload!));
    expect(channels[channel].queried).toEqual([order.out_trade_no]);
    await onlyAnomaly(f, kit, order, trade, '2026-10-22');
    expect(sends(kit, 'order.query')).toEqual([]);
    expect(sends(kit, 'order.close')).toEqual([]);
    // The placement's own prepay attempt, then the query.
    expect(await attemptsOf(f, order.id)).toHaveLength(2);
  },
  90_000,
);
