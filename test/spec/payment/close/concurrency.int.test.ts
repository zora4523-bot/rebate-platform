// B2-15d real-concurrency rule tests (claude-independent, SPEC_REF ec81e625): 08 BR-PAY-02 (PO2、PO3
// 都先取业务对象级的锁，拿到锁后重新读取再判断；状态 CAS，PAID、CLOSED 为终态), BR-PAY-05 ④ (CLOSED 的
// 单不得再变为 PAID；渠道侧对 CLOSED 的单有收款 → 异常收款), BR-PAY-07; task §9.4 (关单与支付通知并发：
// 锁 + CAS 只一个结果生效；通知先到则关单重读为 PAID 结束，关单先到则通知走异常收款).
// Barrier: a second connection holds the business object's advisory lock (B2-15b's key); the
// notification goes through the real api entry, the close through runOrderClose with the entry's
// own job queue and event bus. Either order may win; exactly one result must hold.
// Top-level it() only (规划/11 §4.3).
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import {
  fixture,
  holdingBizLock,
  lockKey,
  payOrder,
  suite,
  track,
  untilWaiting,
  type Fixture,
  type OrderRow,
  type Tracked,
} from '../orders/kit.ts';
import {
  acked,
  anomalies,
  anomalyVoucherOf,
  jobKit,
  paidEvents,
  paidNotification,
  receiptOf,
  tradeNo,
  vouchers,
  withNotify,
  type Delivery,
} from '../result/kit.ts';
import { closeChannels, closePayload, closeRunner, seedClosing } from './kit.ts';

const s = suite();

/** The deliveries of settled operations; a rejected one fails the test with its own error. */
function deliveries(settled: PromiseSettledResult<Delivery | null>[]): Delivery[] {
  const out: Delivery[] = [];
  for (const result of settled) {
    if (result.status === 'rejected') throw result.reason as Error;
    if (result.value !== null) out.push(result.value);
  }
  return out;
}

/**
 * Exactly one result: PAID with its one PAY_RECEIPT and no anomaly, or CLOSED with one anomaly
 * receipt of the notified payment (and its PAY_ANOMALY voucher), no receipt, no paid event.
 */
async function oneResult(f: Fixture, order: OrderRow, trade: string): Promise<void> {
  const after = await payOrder(f, order.id);
  expect(['PAID', 'CLOSED']).toContain(after.status);
  const rows = await anomalies(f);
  if (after.status === 'PAID') {
    expect(after).toMatchObject({ channel_trade_no: trade, closed_at: null });
    expect(await vouchers(f)).toEqual([receiptOf(order)]);
    expect(rows).toEqual([]);
    expect(await paidEvents(f)).toHaveLength(1);
    return;
  }
  expect(after).toMatchObject({ paid_at: null, channel_trade_no: null });
  expect(rows.map((row) => [row.channel_trade_no, row.pay_order_id, row.amount_fen])).toEqual([
    [trade, order.id, order.amount_fen],
  ]);
  expect(await vouchers(f)).toEqual([anomalyVoucherOf(rows[0]!)]);
  expect(await paidEvents(f)).toEqual([]);
}

it.each([
  ['close', 'notify', 'wechat_pay'],
  ['notify', 'close', 'alipay'],
] as const)(
  '[AC-B2-15d#14] 真实并发：%s 先等业务对象锁、%s 后等（%s）：关单与支付通知只有一个结果生效——要么 PAID + 恰一张 PAY_RECEIPT、无异常收款、不关闭，要么 CLOSED + 一条异常收款（PAY_ANOMALY）、无 PAY_RECEIPT、无 pay_order.paid；通知都应答成功',
  async (first, second, channel: PayChannelCode) => {
    const f = await fixture(s);
    const channels = closeChannels(f);
    const order = await seedClosing(f, channel);
    channels[channel].script(order, 'not_paid');
    const trade = tradeNo(channel);
    const built = paidNotification(channels, channels[channel].identity, order, {
      channelTradeNo: trade,
    });
    await withNotify(f, channels, async (h) => {
      const kit = await jobKit(f, channels, { queue: h.queue, events: h.events });
      const close = await closeRunner(kit);
      const key = lockKey(f, order.biz_ref);
      const start = (who: 'close' | 'notify'): Tracked<Delivery | null> =>
        track(
          who === 'notify'
            ? h.deliver(channel, built.raw)
            : close(closePayload(order, 'user_cancel')).then(() => null),
        );
      const settled = await holdingBizLock(f, key, async (release) => {
        const one = start(first);
        expect(await untilWaiting(f, key, 1, [one]), `${first} waits on the lock`).toBe(true);
        const two = start(second);
        expect(await untilWaiting(f, key, 2, [one, two]), `${second} waits too`).toBe(true);
        await release();
        return Promise.allSettled([one.promise, two.promise]);
      });
      for (const sent of deliveries(settled)) acked(channel, sent);
      await oneResult(f, order, trade);
    });
  },
  90_000,
);

/** Per order of the app: status, PAY_RECEIPT vouchers, anomaly rows and their PAY_ANOMALY vouchers. */
async function tallies(f: Fixture) {
  const result = await sql<{
    id: string;
    status: string;
    receipts: number;
    anomalies: number;
    anomaly_vouchers: number;
  }>`
    SELECT o.id::text AS id, o.status,
      (SELECT count(*)::int FROM app.ledger_vouchers v
        WHERE v.app_id = o.app_id AND v.uniq_key = 'PAY_RECEIPT:' || o.id::text) AS receipts,
      (SELECT count(*)::int FROM app.pay_anomalies a
        WHERE a.app_id = o.app_id AND a.pay_order_id = o.id) AS anomalies,
      (SELECT count(*)::int FROM app.ledger_vouchers v JOIN app.pay_anomalies a
          ON a.app_id = v.app_id AND v.uniq_key = 'PAY_ANOMALY:' || a.id::text
        WHERE a.app_id = o.app_id AND a.pay_order_id = o.id) AS anomaly_vouchers
    FROM app.pay_orders o WHERE o.app_id = ${f.subject.app_id}
    ORDER BY o.created_at, o.id`.execute(f.db);
  return result.rows;
}

it('[AC-B2-15d#15] 压力：40 轮里关单任务与同一张单的支付通知同时到达（两渠道、先后轮换）：每张单只有一个结果——PAID 且恰一张 PAY_RECEIPT、无异常收款，或 CLOSED 且恰一条异常收款与一张 PAY_ANOMALY、无 PAY_RECEIPT；通知都应答成功', async () => {
  const f = await fixture(s);
  const channels = closeChannels(f);
  await withNotify(f, channels, async (h) => {
    const kit = await jobKit(f, channels, { queue: h.queue, events: h.events });
    const close = await closeRunner(kit);
    for (let round = 0; round < 40; round += 1) {
      const channel: PayChannelCode = round % 2 === 0 ? 'wechat_pay' : 'alipay';
      const order = await seedClosing(f, channel, { amount_fen: BigInt(100 + round) });
      channels[channel].script(order, 'not_paid');
      const built = paidNotification(channels, channels[channel].identity, order);
      const ops: (() => Promise<Delivery | null>)[] = [
        () => close(closePayload(order, 'user_cancel')).then(() => null),
        () => h.deliver(channel, built.raw),
      ];
      const ordered = Math.floor(round / 2) % 2 === 0 ? ops : [...ops].reverse();
      const settled = await Promise.allSettled(ordered.map((op) => op()));
      for (const sent of deliveries(settled)) acked(channel, sent);
    }
    const rows = await tallies(f);
    expect(rows).toHaveLength(40);
    const wrong = rows.filter(
      (row) =>
        !(
          (row.status === 'PAID' &&
            row.receipts === 1 &&
            row.anomalies === 0 &&
            row.anomaly_vouchers === 0) ||
          (row.status === 'CLOSED' &&
            row.receipts === 0 &&
            row.anomalies === 1 &&
            row.anomaly_vouchers === 1)
        ),
    );
    expect(wrong).toEqual([]);
  });
}, 300_000);
