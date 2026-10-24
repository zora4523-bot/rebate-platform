// B2-15c fulfilment job rule tests (claude-independent, SPEC_REF ec81e625): 08 BR-PAY-04 (开通任务
// 提交后执行；开通任务失败不回滚支付结果), BR-PAY-01 细则「业务类型的接入要求」(按业务对象串行、按当前
// 支付与退款事实重算); D10-168 (pay_fulfillments, BizTypeEntry.fulfillment.reconcile); task §9.4,
// §9.7. The biz.reconcile job is the one the settlement itself enqueued. Top-level it() only.
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  createBizRegistry,
  type BizTypeRegistry,
} from '../../../../apps/api/src/modules/payment/application/biz-registry.ts';
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
} from '../orders/kit.ts';
import {
  AMOUNT,
  BIZ,
  fulfillments,
  jobKit,
  payJobHandler,
  receiptOf,
  received,
  returnedQuery,
  seedPending,
  sends,
  specChannels,
  tradeNo,
  vouchers,
} from './kit.ts';

const s = suite();

/** A PENDING order settled through a query job; the biz.reconcile job that settlement enqueued. */
async function settled(f: Fixture, registry?: BizTypeRegistry, channel: PayChannelCode = 'alipay') {
  const { channels, identity } = specChannels(f);
  const order = await seedPending(f, channel);
  channels[channel].setTrade(
    order.out_trade_no,
    channels[channel].paid(identity[channel], AMOUNT, tradeNo(channel)),
  );
  const kit = await jobKit(f, channels, registry === undefined ? {} : { registry });
  const handle = await payJobHandler(kit);
  await handle(returnedQuery(order));
  expect((await payOrder(f, order.id)).status).toBe('PAID');
  const reconcile = sends(kit, 'biz.reconcile');
  expect(reconcile).toHaveLength(1);
  const job = received(reconcile[0]!.name, reconcile[0]!.payload);
  return { order, kit, handle, job };
}

/** A SUCCESS refund fact of the order: the refund row and the order's refunded_fen. */
async function refunded(f: Fixture, order: OrderRow, amountFen: bigint, totalFen: bigint) {
  await f.db
    .insertInto('pay_refunds')
    .values({
      id: randomUUID(),
      app_id: order.app_id,
      target_type: 'pay_order',
      target_id: order.id,
      idempotency_key: randomUUID(),
      out_refund_no: `R${randomBytes(10).toString('hex').toUpperCase()}`,
      amount_fen: amountFen,
      reason_code: 'OTHER',
      status: 'SUCCESS',
      channel_refund_no: `fixture-refund-${randomUUID()}`,
      operator: 'b2-15c-spec',
      created_at: f.clock.now(),
      succeeded_at: f.clock.now(),
      failed_at: null,
    })
    .execute();
  await f.db
    .updateTable('pay_orders')
    .set({ refunded_fen: totalFen, updated_at: f.clock.now() })
    .where('app_id', '=', order.app_id)
    .where('id', '=', order.id)
    .execute();
}

it('[AC-B2-15c#24] 结算入队的 biz.reconcile 执行后业务对象为 active（last_pay_order_id、refunded_fen 0、applied_at）；再执行一次仍 active、version 加一，不叠加、不再记账', async () => {
  const f = await fixture(s);
  const { order, handle, job } = await settled(f);
  expect(await fulfillments(f)).toEqual([]);
  f.clock.advanceMs(1_000);
  await handle(job);
  const first = await fulfillments(f);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({
    app_id: f.subject.app_id,
    biz_type: BIZ,
    biz_ref: order.biz_ref,
    state: 'active',
    last_pay_order_id: order.id,
    refunded_fen: 0n,
    applied_at: f.clock.now(),
  });
  const version = first[0]!.version;
  f.clock.advanceMs(1_000);
  await handle(job);
  const second = await fulfillments(f);
  expect(second).toHaveLength(1);
  expect(second[0]).toMatchObject({
    id: first[0]!.id,
    state: 'active',
    last_pay_order_id: order.id,
    refunded_fen: 0n,
    version: version + 1n,
    applied_at: f.clock.now(),
  });
  expect(await vouchers(f)).toEqual([receiptOf(order)]);
}, 60_000);

it('[AC-B2-15c#25] 开通按当前支付与退款事实重算：部分退款后仍 active 并记 refunded_fen；退完后 revoked', async () => {
  const f = await fixture(s);
  const { order, handle, job } = await settled(f);
  await handle(job);
  expect((await fulfillments(f))[0]).toMatchObject({ state: 'active', refunded_fen: 0n });

  f.clock.advanceMs(60_000);
  await refunded(f, order, 345n, 345n);
  await handle(job);
  expect((await fulfillments(f))[0]).toMatchObject({
    state: 'active',
    last_pay_order_id: order.id,
    refunded_fen: 345n,
    applied_at: f.clock.now(),
  });

  f.clock.advanceMs(60_000);
  await refunded(f, order, AMOUNT - 345n, AMOUNT);
  await handle(job);
  const rows = await fulfillments(f);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    state: 'revoked',
    last_pay_order_id: order.id,
    refunded_fen: AMOUNT,
    applied_at: f.clock.now(),
  });
  expect((await payOrder(f, order.id)).status).toBe('PAID');
}, 60_000);

it('[AC-B2-15c#26] 开通任务按业务对象串行：对象锁被别的事务占着时等待，放开后才写 pay_fulfillments', async () => {
  const f = await fixture(s);
  const { order, handle, job } = await settled(f, undefined, 'wechat_pay');
  const key = lockKey(f, order.biz_ref);
  await holdingBizLock(f, key, async (release) => {
    const run = track(handle(job));
    expect(await untilWaiting(f, key, 1, [run]), 'the reconcile job waits on the object lock').toBe(
      true,
    );
    expect(await fulfillments(f)).toEqual([]);
    await release();
    await run.promise;
  });
  expect((await fulfillments(f))[0]).toMatchObject({ state: 'active', biz_ref: order.biz_ref });
}, 60_000);

it('[AC-B2-15c#27] 业务类型的开通处理器失败不回滚支付结果：任务失败交给队列重试，支付单仍 PAID、收款凭证仍在、pay_fulfillments 不变', async () => {
  const f = await fixture(s);
  const base = createBizRegistry('test');
  const entry = base.get(BIZ);
  expect(entry).toBeDefined();
  const failing: BizTypeRegistry = {
    get: (code) =>
      code === BIZ && entry !== undefined
        ? {
            ...entry,
            fulfillment: {
              reconcile: () => Promise.reject(new Error('spec: fulfilment unavailable')),
            },
          }
        : base.get(code),
    list: () => base.list(),
  };
  const { order, handle, job } = await settled(f, failing);
  await expect(handle(job)).rejects.toThrow();
  expect((await payOrder(f, order.id)).status).toBe('PAID');
  expect(await vouchers(f)).toEqual([receiptOf(order)]);
  expect(await fulfillments(f)).toEqual([]);
}, 60_000);
