// B2-15d expiry rule tests (claude-independent, SPEC_REF ec81e625): 08 BR-PAY-05 ② (「单据不存在」不等
// 于已关闭：过了 expire_at + pay.close_grace_minutes 且再次查询仍不存在才 PO3；在此之前支付单保持
// PENDING、业务对象不释放、不能换渠道重新下单), ③ (过了 expire_at 之后每 pay.close_retry_minutes 重做；
// 到 expire_at + pay.close_wait_minutes 仍没有结果 → needs_manual、告警、停止自动处理), BR-PAY-02 细则
// (换渠道：原单关闭成功才建新单，未关闭返回 20902), BR-PAY-03 (closing 后不再返回调起参数); task §9.2,
// §9.3, §9.5, §9.6 (默认 10 / 5 / 60 分钟，config_items 同名覆盖); D10-236 ④.
// The close job's handler runs over the fixture's database with scripted spec channels and the
// fixture's FixedClock; the next runs it enqueues are recorded and handed back to it by the test.
// Orders are placed and cancelled through the api entry where the business object's release is
// checked. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  answer,
  conflict,
  createBody,
  enable,
  fixture,
  payOrder,
  setConfig,
  success,
  suite,
  withHttp,
} from '../orders/kit.ts';
import {
  CHANNELS,
  anomalies,
  jobKit,
  receiptOf,
  seedPending,
  vouchers,
  warnings,
} from '../result/kit.ts';
import {
  GRACE_MS,
  RETRY_SECONDS,
  WAIT_MS,
  closeChannels,
  closeJobs,
  closePayload,
  closeRunner,
  closeSends,
  seedClosing,
} from './kit.ts';

const s = suite();

it.each([
  [-1_000, 'PENDING', 'wechat_pay'],
  [0, 'CLOSED', 'alipay'],
  [60_000, 'CLOSED', 'wechat_pay'],
] as const)(
  '[AC-B2-15d#9] 时刻矩阵：渠道一直答「单据不存在」，关单在 expire_at + 宽限（10 分钟）%i 毫秒执行 → %s（%s）：宽限到点之前不关；到点及之后本次再查仍不存在才 PO3',
  async (offset, expected, channel) => {
    const f = await fixture(s);
    const channels = closeChannels(f);
    const order = await seedClosing(f, channel);
    channels[channel].script(order, 'not_exist');
    const due = order.expire_at.getTime() + GRACE_MS;
    f.clock.set(new Date(due + offset));
    const kit = await jobKit(f, channels);
    const close = await closeRunner(kit);
    await close(closePayload(order, 'user_cancel'));
    const after = await payOrder(f, order.id);
    expect(after.status).toBe(expected);
    expect(after).toMatchObject(
      expected === 'CLOSED'
        ? { closed_at: f.clock.now(), close_reason: 'user_cancel', needs_manual: false }
        : { closing: true, closed_at: null, needs_manual: false },
    );
    expect(channels[channel].opsOf(order), 'queried in this run').toContain('query');
    expect(closeSends(kit, order)).toHaveLength(expected === 'CLOSED' ? 0 : 1);
    expect(await vouchers(f)).toEqual([]);
  },
  60_000,
);

it('[AC-B2-15d#10] 用户取消（换渠道须先取消原单）后渠道答「单据不存在」：宽限前支付单保持 PENDING、业务对象不释放——同渠道、换渠道再下单都 20902（resource=pay_order）、不给调起参数；过了 expire_at + 宽限再查仍不存在才 CLOSED，之后换渠道新建支付单成功', async () => {
  const f = await fixture(s);
  await enable(f);
  const bizRef = randomUUID();
  let id = '';
  await withHttp(f, async (send) => {
    const data = await success(await send('create', { body: createBody(bizRef, 'wechat_pay') }));
    id = String(data['pay_order_id']);
    f.clock.advanceMs(60_000);
    await success(await send('cancel', { id }));
  });
  const order = await payOrder(f, id);
  expect(order).toMatchObject({ status: 'PENDING', closing: true, close_reason: 'user_cancel' });
  const queued = await closeJobs(f, order);
  expect(queued.map((job) => job.singleton_key)).toEqual([`order.close:${id}`]);
  expect(queued[0]?.payload).not.toBeNull();

  const channels = closeChannels(f);
  channels.wechat_pay.script(order, 'not_exist');
  const kit = await jobKit(f, channels);
  const close = await closeRunner(kit);
  await close(queued[0]!.payload!);
  expect(await payOrder(f, id)).toMatchObject({
    status: 'PENDING',
    closing: true,
    closed_at: null,
  });
  const next = closeSends(kit, order);
  expect(next).toHaveLength(1);
  await withHttp(f, async (send) => {
    for (const channel of CHANNELS) {
      await answer(await send('create', { body: createBody(bizRef, channel) }), 20902, conflict);
    }
  });

  // Past expire_at + grace: asked again, still not there → PO3.
  f.clock.set(new Date(order.expire_at.getTime() + GRACE_MS));
  const calls = channels.wechat_pay.calls.length;
  await close(next[0]!.payload);
  expect(await payOrder(f, id)).toMatchObject({
    status: 'CLOSED',
    closed_at: f.clock.now(),
    close_reason: 'user_cancel',
  });
  expect(channels.wechat_pay.calls.slice(calls).map((call) => call.op)).toContain('query');
  await withHttp(f, async (send) => {
    const data = await success(await send('create', { body: createBody(bizRef, 'alipay') }));
    expect(data).toMatchObject({ biz_ref: bizRef, pay_channel: 'alipay', status: 'PENDING' });
    expect(data['pay_order_id']).not.toBe(id);
  });
}, 90_000);

it.each(CHANNELS)(
  '[AC-B2-15d#11] %s 「单据不存在」不等于已关闭：到期查询不存在、宽限内渠道又查到已支付（在途的下单到了、用户付了款）→ PO2，恰一张 PAY_RECEIPT，不关闭、无异常收款',
  async (channel) => {
    const f = await fixture(s);
    const channels = closeChannels(f);
    const order = await seedPending(f, channel);
    channels[channel].script(order, 'not_exist');
    f.clock.set(order.expire_at);
    const kit = await jobKit(f, channels);
    const close = await closeRunner(kit);
    await close(closePayload(order, 'expired'));
    expect(await payOrder(f, order.id)).toMatchObject({
      status: 'PENDING',
      closing: true,
      close_reason: 'expired',
    });
    const next = closeSends(kit, order);
    expect(next).toHaveLength(1);

    const trade = channels[channel].scriptPaid(order);
    f.clock.set(new Date(order.expire_at.getTime() + RETRY_SECONDS * 1000));
    await close(next[0]!.payload);
    expect(await payOrder(f, order.id)).toMatchObject({
      status: 'PAID',
      channel_trade_no: trade,
      paid_at: f.clock.now(),
      closed_at: null,
    });
    expect(await vouchers(f)).toEqual([receiptOf(order)]);
    expect(await anomalies(f)).toEqual([]);
    expect(closeSends(kit, order)).toHaveLength(1);
  },
  60_000,
);

it.each([
  ['wechat_pay', 'timeout', 'channel'],
  ['alipay', 'not_paid', 'unknown'],
] as const)(
  '[AC-B2-15d#12] %s 过期后渠道一直没有结果（查询 %s、关单 %s）：置 closing、close_reason=expired，每 5 分钟重做一次（任务自我续期、延迟 300 秒）；到 expire_at + 60 分钟仍无结果 → needs_manual、告警 pay_order_needs_manual、不再入队；之后再来的任务不再问渠道',
  async (channel, state, closeAnswer) => {
    const f = await fixture(s);
    const channels = closeChannels(f);
    const order = await seedPending(f, channel);
    channels[channel].script(order, state, closeAnswer);
    const expireAt = order.expire_at.getTime();
    const kit = await jobKit(f, channels);
    const close = await closeRunner(kit);
    let payload = closePayload(order, 'expired');
    for (let k = 0; k * RETRY_SECONDS * 1000 < WAIT_MS; k += 1) {
      const at = `expire_at + ${(k * RETRY_SECONDS) / 60} min`;
      f.clock.set(new Date(expireAt + k * RETRY_SECONDS * 1000));
      const sent = closeSends(kit, order).length;
      const calls = channels[channel].calls.length;
      // An unknown answer may also fail the job (the queue retries it); the next run is enqueued.
      await close(payload).catch(() => undefined);
      expect(await payOrder(f, order.id), at).toMatchObject({
        status: 'PENDING',
        closing: true,
        close_reason: 'expired',
        needs_manual: false,
        closed_at: null,
      });
      const ops = channels[channel].calls.slice(calls).map((call) => call.op);
      expect(ops, at).toContain('query');
      expect(state === 'timeout' || ops.includes('close'), `${at}: the close was asked`).toBe(true);
      const fresh = closeSends(kit, order).slice(sent);
      expect(
        fresh.map((job) => [job.queue, job.options.delaySeconds]),
        at,
      ).toEqual([['pay', RETRY_SECONDS]]);
      expect(fresh[0]!.options.singletonKey?.startsWith(`order.close:${order.id}`), at).toBe(true);
      payload = fresh[0]!.payload;
    }

    f.clock.set(new Date(expireAt + WAIT_MS));
    const sent = kit.sent.length;
    await close(payload).catch(() => undefined);
    const manual = await payOrder(f, order.id);
    expect(manual).toMatchObject({ status: 'PENDING', needs_manual: true, closed_at: null });
    expect(kit.sent.slice(sent)).toEqual([]);
    expect(
      warnings(kit.logs, 'pay_order_needs_manual').map((entry) => entry['pay_order_id']),
    ).toEqual([order.id]);

    // A run that still comes later (a duplicate, an operator's replay): stopped, nothing asked.
    f.clock.set(new Date(expireAt + WAIT_MS + RETRY_SECONDS * 1000));
    const calls = channels[channel].calls.length;
    await close(payload);
    expect(channels[channel].calls.length).toBe(calls);
    expect(kit.sent.slice(sent)).toEqual([]);
    expect(await payOrder(f, order.id)).toEqual(manual);
    expect(warnings(kit.logs, 'pay_order_needs_manual')).toHaveLength(1);
    expect(await vouchers(f)).toEqual([]);
  },
  90_000,
);

it('[AC-B2-15d#13] 关单节奏的三个配置键可由 config_items 同名覆盖：pay.close_retry_minutes=10（续期延迟 600 秒）、pay.close_wait_minutes=30（30 分钟到点 needs_manual）、pay.close_grace_minutes=3（「单据不存在」3 分钟宽限）', async () => {
  const f = await fixture(s);
  await setConfig(f, 'pay.close_retry_minutes', 10);
  await setConfig(f, 'pay.close_wait_minutes', 30);
  await setConfig(f, 'pay.close_grace_minutes', 3);
  const channels = closeChannels(f);
  const kit = await jobKit(f, channels);
  const close = await closeRunner(kit);

  const silent = await seedPending(f, 'wechat_pay');
  channels.wechat_pay.script(silent, 'timeout');
  const expireAt = silent.expire_at.getTime();
  let payload = closePayload(silent, 'expired');
  for (const minute of [0, 10, 20]) {
    f.clock.set(new Date(expireAt + minute * 60_000));
    const sent = closeSends(kit, silent).length;
    await close(payload).catch(() => undefined);
    const fresh = closeSends(kit, silent).slice(sent);
    expect(
      fresh.map((job) => job.options.delaySeconds),
      `expire_at + ${minute} min`,
    ).toEqual([600]);
    expect(await payOrder(f, silent.id)).toMatchObject({ status: 'PENDING', needs_manual: false });
    payload = fresh[0]!.payload;
  }
  f.clock.set(new Date(expireAt + 30 * 60_000));
  const sent = closeSends(kit, silent).length;
  await close(payload).catch(() => undefined);
  expect(await payOrder(f, silent.id)).toMatchObject({ status: 'PENDING', needs_manual: true });
  expect(closeSends(kit, silent).slice(sent)).toEqual([]);

  const missing = await seedClosing(f, 'alipay');
  channels.alipay.script(missing, 'not_exist');
  const due = missing.expire_at.getTime() + 3 * 60_000;
  f.clock.set(new Date(due - 1_000));
  await close(closePayload(missing, 'user_cancel'));
  expect((await payOrder(f, missing.id)).status).toBe('PENDING');
  const again = closeSends(kit, missing);
  expect(again).toHaveLength(1);
  f.clock.set(new Date(due));
  await close(again[0]!.payload);
  expect(await payOrder(f, missing.id)).toMatchObject({
    status: 'CLOSED',
    closed_at: f.clock.now(),
  });
}, 90_000);
