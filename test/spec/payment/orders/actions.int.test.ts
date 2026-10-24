// B2-15b rule tests of GET /v1/pay/orders/{id}, …/returned and …/cancel (claude-independent,
// SPEC_REF 48e55e6a): 08 BR-PAY-01 ④ (开关关闭只影响新下单), BR-PAY-03 细则 (客户端返回后立即查询
// 一次), BR-PAY-04 (SDK 结果不作依据), BR-PAY-05 (用户取消进入关单流程); contract CT-21c; ruling
// D10-245 (GET unsigned); task §9.7 ～ §9.9. Queue assertions read pgboss.job.
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  answer,
  attempts,
  conflict,
  createBody,
  enable,
  fixture,
  normalize,
  payJobs,
  payOrder,
  payOrders,
  seedOrder,
  setConfig,
  success,
  suite,
  view,
  withHttp,
  type Fixture,
} from './kit.ts';

const s = suite();

/** The three states a user can look at; payment switched off (BR-PAY-01 ④). */
async function threeOrders(f: Fixture) {
  await setConfig(f, 'pay.enabled', false);
  const pending = await seedOrder(f, { launch_issued_at: f.clock.now() });
  const paid = await seedOrder(f, {
    pay_channel: 'alipay',
    status: 'PAID',
    paid_at: f.clock.now(),
    launch_issued_at: f.clock.now(),
    channel_trade_no: 'FIXTURE-TRADE-2',
  });
  const closed = await seedOrder(f, {
    status: 'CLOSED',
    closed_at: f.clock.now(),
    close_reason: 'expired',
  });
  return { pending, paid, closed };
}

/** The app's pay orders are exactly these rows, unchanged. */
async function unchanged(f: Fixture, rows: ReadonlyArray<Awaited<ReturnType<typeof seedOrder>>>) {
  const now = await payOrders(f);
  expect(now).toHaveLength(rows.length);
  expect(now).toEqual(expect.arrayContaining([...rows]));
}

it('[AC-B2-15b#26] GET 本人的支付单：PENDING / PAID / CLOSED 按 PayOrder 原样显示，不带调起参数，不需请求签名（D10-245），开关关闭照常', async () => {
  const f = await fixture(s);
  const { pending, paid, closed } = await threeOrders(f);
  await withHttp(f, async (send) => {
    for (const row of [pending, paid, closed]) {
      const data = await success(await send('get', { id: row.id, signed: false }));
      expect(data).not.toHaveProperty('launch');
      expect(normalize(data)).toEqual(view(row));
    }
  });
}, 60_000);

it('[AC-B2-15b#27] GET 别人的单或不存在的单：都是 HTTP 404 / 30701，不区分', async () => {
  const f = await fixture(s);
  const { pending } = await threeOrders(f);
  const stranger = await f.stranger();
  await withHttp(f, async (send) => {
    await answer(await send('get', { id: pending.id, subject: stranger }), 30701);
    await answer(await send('get', { id: randomUUID() }), 30701);
    const other = await send('get', { id: pending.id, subject: stranger });
    const missing = await send('get', { id: randomUUID() });
    expect(other.json().msg).toBe(missing.json().msg);
    expect(other.json()).not.toHaveProperty('data');
  });
}, 60_000);

it('[AC-B2-15b#28] returned：PENDING 单入队一次立即查询（pay / order.query / order.query:<id>:returned），再调不再入队，返回空对象，不改单', async () => {
  const f = await fixture(s);
  const { pending } = await threeOrders(f);
  await withHttp(f, async (send) => {
    await answer(await send('returned', { id: pending.id }), 0, {});
    await answer(await send('returned', { id: pending.id }), 0, {});
    const jobs = await payJobs(f, pending.id);
    expect(jobs.map((job) => [job.job, job.singleton_key])).toEqual([
      ['order.query', `order.query:${pending.id}:returned`],
    ]);
    expect(jobs[0]!.delay).toBeLessThanOrEqual(1);
    expect(await payOrder(f, pending.id)).toEqual(pending);
    expect(await attempts(f)).toEqual([]);
  });
}, 60_000);

it('[AC-B2-15b#29] returned：PAID / CLOSED 单照样返回成功但不入队；别人的单 30701 且不入队', async () => {
  const f = await fixture(s);
  const { pending, paid, closed } = await threeOrders(f);
  const stranger = await f.stranger();
  await withHttp(f, async (send) => {
    for (const row of [paid, closed]) {
      await answer(await send('returned', { id: row.id }), 0, {});
      expect(await payJobs(f, row.id)).toEqual([]);
    }
    await answer(await send('returned', { id: pending.id, subject: stranger }), 30701);
    await answer(await send('returned', { id: randomUUID() }), 30701);
    expect(await payJobs(f, pending.id)).toEqual([]);
    await unchanged(f, [pending, paid, closed]);
  });
}, 60_000);

it('[AC-B2-15b#30] cancel：PENDING 单置 closing=true、close_reason=user_cancel 并入队一次关单任务，状态仍 PENDING；之后同渠道与换渠道下单都是 20902', async () => {
  const f = await fixture(s);
  await enable(f);
  await withHttp(f, async (send) => {
    const bizRef = randomUUID();
    const created = await success(await send('create', { body: createBody(bizRef, 'wechat_pay') }));
    const id = String(created['pay_order_id']);
    f.clock.advanceMs(5_000);
    const data = await success(await send('cancel', { id }));
    const row = await payOrder(f, id);
    expect(row).toMatchObject({
      status: 'PENDING',
      closing: true,
      close_reason: 'user_cancel',
      closed_at: null,
      paid_at: null,
    });
    expect(normalize(data)).toEqual(view(row));
    expect((await payJobs(f, id)).map((job) => [job.job, job.singleton_key])).toEqual([
      ['order.close', `order.close:${id}`],
    ]);
    // 先查后关在关单任务里（B2-15d）：取消本身不向渠道查询或关单。
    expect((await attempts(f)).map((attempt) => attempt.kind)).toEqual(['query']);
    for (const channel of ['wechat_pay', 'alipay'] as const) {
      await answer(await send('create', { body: createBody(bizRef, channel) }), 20902, conflict);
    }
    expect(f.channels.wechat_pay.createCalls()).toHaveLength(1);
    expect(f.channels.alipay.createCalls()).toEqual([]);
    expect(await payOrders(f)).toHaveLength(1);
  });
}, 60_000);

it('[AC-B2-15b#31] cancel：开关关闭照样可取消；PAID / CLOSED 单 20902 resource=pay_order；别人的单 30701；都不改单、不入队', async () => {
  const f = await fixture(s);
  const { pending, paid, closed } = await threeOrders(f);
  const stranger = await f.stranger();
  await withHttp(f, async (send) => {
    for (const row of [paid, closed]) {
      await answer(await send('cancel', { id: row.id }), 20902, conflict);
      expect(await payJobs(f, row.id)).toEqual([]);
    }
    await answer(await send('cancel', { id: pending.id, subject: stranger }), 30701);
    await answer(await send('cancel', { id: randomUUID() }), 30701);
    expect(await payJobs(f, pending.id)).toEqual([]);
    await unchanged(f, [pending, paid, closed]);
    await success(await send('cancel', { id: pending.id }));
    expect(await payOrder(f, pending.id)).toMatchObject({
      status: 'PENDING',
      closing: true,
      close_reason: 'user_cancel',
    });
    expect((await payJobs(f, pending.id)).map((job) => job.job)).toEqual(['order.close']);
  });
}, 60_000);
