// B2-15e concurrency rule tests (claude-independent, SPEC_REF c4cfc1a2): 08 BR-PAY-06 ②③ (同一个键
// 只对应一张退款单；先取业务对象级锁，再校验「已成功 + 处理中」+ 本次 ≤ 可退金额); AC-S2-82 ⑭ (同键提交
// 两次只一张退款单；并发两笔部分退款只成功一笔、合计不超可退). Real concurrency through the admin
// entry: the test holds the business object's advisory lock (task B2-15b §9.4 key
// payment.biz:<app_id>:<biz_type>:<biz_ref>, infra/pay-order-store.ts lockBizObject) on a second
// connection while both requests queue up behind it, then releases it. Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  fixture,
  holdingBizLock,
  lockKey,
  payOrder,
  suite,
  track,
  untilWaiting,
} from '../orders/kit.ts';
import {
  AMOUNT,
  answer,
  created,
  idempotencyRows,
  newKey,
  refundBody,
  refundChannels,
  refundJobs,
  refunds,
  seedPaid,
  withAdmin,
  type AdminSent,
} from './kit.ts';

const s = suite();

it('[AC-B2-15e#23] AC-S2-82 ⑭ 真实并发：同一支付单两笔不同幂等键的部分退款（各 7000 分，合计超过 12345 分）在业务对象锁后排队，只有一笔建单并提交渠道，另一笔 20001 data.fields=[amount_fen]；占用合计不超过可退金额', async () => {
  const f = await fixture(s);
  const { channels } = refundChannels(f);
  const { kit } = await refundJobs(f, channels);
  const order = await seedPaid(f, kit, 'wechat_pay');
  expect(order.amount_fen).toBe(AMOUNT);
  await withAdmin(f, channels, async (h) => {
    const target = { type: 'pay_order', id: order.id } as const;
    const key = lockKey(f, order.biz_ref);
    const sent: AdminSent[] = await holdingBizLock(f, key, async (release) => {
      const first = track(h.refund(target, refundBody(7_000), { key: newKey() }));
      const second = track(h.refund(target, refundBody(7_000), { key: newKey() }));
      const waiting = await untilWaiting(f, key, 2, [first, second]);
      await release();
      const results = await Promise.all([first.promise, second.promise]);
      expect(waiting, 'both requests wait for the business object lock').toBe(true);
      return results;
    });
    const byCode = [...sent].sort((a, b) => a.json().code - b.json().code);
    await created(byCode[0]!);
    await answer(byCode[1]!, 20001, { fields: ['amount_fen'] });
  });
  const rows = await refunds(f);
  expect(rows.map((row) => [row.status, row.amount_fen])).toEqual([['PROCESSING', 7_000n]]);
  expect(channels.wechat_pay.submitted.map((input) => input.outRefundNo)).toEqual([
    rows[0]?.out_refund_no,
  ]);
  expect(await payOrder(f, order.id)).toMatchObject({ status: 'PAID', refunded_fen: 0n });
});

it('[AC-B2-15e#24] AC-S2-82 ⑭ 真实并发：同一幂等键、同一请求体同时提交两次只有一张退款单、一次渠道提交；另一次是 40901（处理中）或原结果；之后再用该键提交返回同一张退款单', async () => {
  const f = await fixture(s);
  const { channels } = refundChannels(f);
  const { kit } = await refundJobs(f, channels);
  const order = await seedPaid(f, kit, 'alipay');
  await withAdmin(f, channels, async (h) => {
    const target = { type: 'pay_order', id: order.id } as const;
    const lock = lockKey(f, order.biz_ref);
    const key = newKey();
    const body = refundBody(3_000, 'DUPLICATE_PAYMENT');
    const sent: AdminSent[] = await holdingBizLock(f, lock, async (release) => {
      const first = track(h.refund(target, body, { key }));
      const second = track(h.refund(target, body, { key }));
      const waiting = await untilWaiting(f, lock, 1, []);
      await release();
      const results = await Promise.all([first.promise, second.promise]);
      expect(waiting, 'one request waits for the business object lock').toBe(true);
      return results;
    });
    const codes = sent.map((one) => one.json().code).sort((a, b) => a - b);
    expect(codes[0], JSON.stringify(codes)).toBe(0);
    expect([0, 40901], JSON.stringify(codes)).toContain(codes[1]);
    const winner = sent.find((one) => one.json().code === 0)!;
    const data = await created(winner);
    for (const one of sent) {
      if (one.json().code === 0) expect(await created(one)).toEqual(data);
      else await answer(one, 40901);
    }
    const later = await created(await h.refund(target, body, { key }));
    expect(later).toEqual(data);
  });
  expect(await refunds(f)).toHaveLength(1);
  expect(channels.alipay.submitted).toHaveLength(1);
  expect((await idempotencyRows(f)).map((row) => row.status)).toEqual(['completed']);
});
