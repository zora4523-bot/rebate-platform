// B2-15b real-concurrency rule tests (claude-independent, SPEC_REF 48e55e6a): 08 BR-PAY-02 (业务
// 对象级锁, 同一业务对象至多一张未关闭的支付单), AC-S2-82 ⑫; task §9.4 (lock key) and §9.12.
// Barrier: a second connection holds the business object's advisory lock; both requests run
// through the real api entry, and the lock is released only after both wait on it, in a known
// order (PostgreSQL grants waiters of one exclusive lock first come, first served).
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  answer,
  conflict,
  createBody,
  enable,
  fixture,
  holdingBizLock,
  lockKey,
  payOrders,
  success,
  suite,
  track,
  untilWaiting,
  withHttp,
  type Sent,
} from './kit.ts';

const s = suite();

it.each([
  ['wechat_pay', 'alipay'],
  ['alipay', 'wechat_pay'],
] as const)(
  '[AC-B2-15b#24] AC-S2-82 ⑫ 真实并发：同一业务对象 %s 先到、%s 后到同时下单，只生成先到者的一张单，后到者 20902 且不向渠道下单',
  async (first, second) => {
    const f = await fixture(s);
    await enable(f);
    const bizRef = randomUUID();
    const key = lockKey(f, bizRef);
    await withHttp(f, async (send) => {
      const [won, lost] = await holdingBizLock(f, key, async (release): Promise<Sent[]> => {
        const a = track(send('create', { body: createBody(bizRef, first) }));
        expect(await untilWaiting(f, key, 1, [a]), 'first request waits on the lock').toBe(true);
        const b = track(send('create', { body: createBody(bizRef, second) }));
        expect(await untilWaiting(f, key, 2, [a, b]), 'both requests wait on the lock').toBe(true);
        await release();
        return [await a.promise, await b.promise];
      });
      const data = await success(won!);
      await answer(lost!, 20902, conflict);
      const rows = await payOrders(f);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: data['pay_order_id'],
        biz_ref: bizRef,
        pay_channel: first,
        status: 'PENDING',
      });
      expect(f.channels[first].createCalls()).toHaveLength(1);
      expect(f.channels[second].createCalls()).toEqual([]);
    });
  },
  60_000,
);

it('[AC-B2-15b#25] 真实并发：同一业务对象同渠道两个下单请求同时到达，只生成一张单，两者都拿到这张单', async () => {
  const f = await fixture(s);
  await enable(f);
  const bizRef = randomUUID();
  const key = lockKey(f, bizRef);
  await withHttp(f, async (send) => {
    const results = await holdingBizLock(f, key, async (release): Promise<Sent[]> => {
      const a = track(send('create', { body: createBody(bizRef, 'wechat_pay') }));
      const b = track(send('create', { body: createBody(bizRef, 'wechat_pay') }));
      expect(await untilWaiting(f, key, 2, [a, b]), 'both requests wait on the lock').toBe(true);
      await release();
      return [await a.promise, await b.promise];
    });
    const ids: unknown[] = [];
    for (const sent of results) ids.push((await success(sent))['pay_order_id']);
    const rows = await payOrders(f);
    expect(rows).toHaveLength(1);
    expect(ids).toEqual([rows[0]!.id, rows[0]!.id]);
    expect(rows[0]).toMatchObject({
      biz_ref: bizRef,
      pay_channel: 'wechat_pay',
      status: 'PENDING',
    });
    expect(f.channels.wechat_pay.createCalls()).toHaveLength(2);
  });
}, 60_000);
