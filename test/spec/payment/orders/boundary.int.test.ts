// B2-15b entry-boundary rule tests (claude-independent, SPEC_REF 48e55e6a): 08 BR-PAY-01 ② (只限
// 原生 App: access_token 有效、请求签名通过、带 Idempotency-Key; H5 不得调用), BR-PAY-01 ③ / BR-FUND-13
// (支付模块不读写余额), AC-S2-82 ⑨⑪; task §9.11, §9.12. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  answer,
  attempts,
  createBody,
  enable,
  fixture,
  ledgerRows,
  payJobs,
  payOrder,
  payOrders,
  seedOrder,
  success,
  suite,
  withHttp,
} from './kit.ts';

const s = suite();

it('[AC-B2-15b#32] AC-S2-82 ⑨：h5_token 调下单、returned、cancel 一律 10403，不落单、不改单、不入队', async () => {
  const f = await fixture(s);
  await enable(f);
  const pending = await seedOrder(f, { launch_issued_at: f.clock.now() });
  await withHttp(f, async (send) => {
    await answer(
      await send('create', { body: createBody(randomUUID(), 'wechat_pay'), token: 'h5' }),
      10403,
    );
    await answer(await send('returned', { id: pending.id, token: 'h5' }), 10403);
    await answer(await send('cancel', { id: pending.id, token: 'h5' }), 10403);
    expect(await payOrders(f)).toEqual([pending]);
    expect(await payJobs(f, pending.id)).toEqual([]);
    expect(f.channels.wechat_pay.createCalls()).toEqual([]);
    // 同一夹具的原生 App 令牌可以下单：拒绝来自令牌种类，不是夹具缺东西。
    await success(await send('create', { body: createBody(randomUUID(), 'wechat_pay') }));
  });
}, 60_000);

it('[AC-B2-15b#33] 受限会话（scp=deletion_only）下单 → 10405，不落单', async () => {
  const f = await fixture(s);
  await enable(f);
  await withHttp(f, async (send) => {
    const sent = await send('create', {
      body: createBody(randomUUID(), 'alipay'),
      token: 'deletion_only',
    });
    await answer(sent, 10405);
    expect(await payOrders(f)).toEqual([]);
    expect(f.channels.alipay.createCalls()).toEqual([]);
    await success(await send('create', { body: createBody(randomUUID(), 'alipay') }));
  });
}, 60_000);

it('[AC-B2-15b#34] 下单、returned、cancel 是签名接口：不带签名或签名不符 → 10401，什么都不写', async () => {
  const f = await fixture(s);
  await enable(f);
  const pending = await seedOrder(f, { launch_issued_at: f.clock.now() });
  await withHttp(f, async (send) => {
    for (const options of [{ signed: false }, { badSign: true }] as const) {
      await answer(
        await send('create', { body: createBody(randomUUID(), 'wechat_pay'), ...options }),
        10401,
      );
      await answer(await send('returned', { id: pending.id, ...options }), 10401);
      await answer(await send('cancel', { id: pending.id, ...options }), 10401);
    }
    expect(await payOrders(f)).toEqual([pending]);
    expect(await payJobs(f, pending.id)).toEqual([]);
    expect(f.channels.wechat_pay.createCalls()).toEqual([]);
    await success(await send('returned', { id: pending.id }));
    expect(await payJobs(f, pending.id)).toHaveLength(1);
  });
}, 60_000);

it('[AC-B2-15b#35] AC-S2-82 ⑪：下单、重取调起参数、渠道未知、returned、cancel 全程不产生任何账务凭证或分录，也不碰余额', async () => {
  const f = await fixture(s);
  await enable(f);
  await withHttp(f, async (send) => {
    const bizRef = randomUUID();
    const body = createBody(bizRef, 'wechat_pay');
    const created = await success(await send('create', { body }));
    const id = String(created['pay_order_id']);
    await success(await send('create', { body }));
    f.channels.wechat_pay.scriptCreate(['unknown']);
    await answer(await send('create', { body }), 50306, { pay_channel: 'wechat_pay' });
    await answer(await send('returned', { id }), 0, {});
    await success(await send('cancel', { id }));
    expect(await payOrder(f, id)).toMatchObject({ status: 'PENDING', closing: true });
    expect((await attempts(f)).map((attempt) => attempt.result)).toEqual([
      'prepay',
      'prepay',
      'unknown',
    ]);
    expect(await ledgerRows(f)).toEqual({ vouchers: 0, entries: 0 });
  });
}, 60_000);
