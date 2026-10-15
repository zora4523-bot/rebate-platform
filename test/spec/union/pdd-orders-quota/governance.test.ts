import { expect, it, vi } from 'vitest';
import type { QuotaLimiter } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  DemoUnionAdapter,
  UnionError,
  type CallCtx,
} from '../../../../apps/api/src/modules/union/index.ts';
import { ManualScheduler, observe } from '../../platform/http/kit.ts';
import { adapter as basicAdapter } from '../skeleton/kit.ts';
import { collect, ctx, detail, row, win } from '../pdd-orders/kit.ts';
import { govern, pageReply, rows, wireSetup } from './kit.ts';

// Task-local AC identifiers: the B1-04w ledger excerpt is the acceptance authority.
it('[AC-B1-04w-GOV#1] 尾页探测和倒序每次真实请求前恰扣一次，缓存命中不重复扣', async () => {
  const events: string[] = [];
  const data = rows();
  const signals: (AbortSignal | undefined)[] = [];
  const { adapter, requests } = wireSetup((body, signal) => {
    events.push(`request:${String(body.page)}`);
    signals.push(signal);
    return pageReply(body, data);
  });
  const take = vi.fn<QuotaLimiter['tryAcquire']>((purpose) => {
    events.push(`quota:${purpose}`);
    return true;
  });
  const result = await collect(govern(adapter, take));
  expect(result.map((order) => order.order_id)).toEqual(
    [...data.slice(100), ...data.slice(50, 100), ...data.slice(0, 50)].map((r) => r.order_sn),
  );
  expect(
    requests
      .map((body) => body.page)
      .filter((page) => Number(page) <= 3)
      .slice(-3),
  ).toEqual([3, 2, 1]);
  expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  expect(events).toEqual(
    requests.flatMap((body) => ['quota:order_sync', `request:${String(body.page)}`]),
  );
});

it.each([1, 2, 3])(
  '[AC-B1-04w-GOV#2] 配额只够 %i 次时恰好发送该次数，中途拒绝不重试、不重走首页',
  async (budget) => {
    let remaining = budget;
    const { adapter, transport } = wireSetup((body) => pageReply(body));
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => remaining-- > 0);
    const port = govern(adapter, take);
    await expect(port.listOrders(win, {}, ctx)).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(transport).toHaveBeenCalledTimes(budget);
    expect(take).toHaveBeenCalledTimes(budget + 1);
    // Keep the same governor alive: local refusals must not become upstream breaker failures.
    for (let i = 0; i < 25; i += 1) {
      await expect(port.listOrders(win, {}, ctx)).rejects.toMatchObject({ code: 'quota_exceeded' });
    }
    expect(transport).toHaveBeenCalledTimes(budget);
    expect(take).toHaveBeenCalledTimes(budget + 26);
    remaining = 20;
    await expect(port.listOrders(win, {}, ctx)).resolves.toMatchObject({
      items: expect.any(Array),
    });
    expect(transport.mock.calls.length).toBeGreaterThan(budget);
  },
);

it.each([52101, 70031])(
  '[AC-B1-04w-GOV#3] 第 2 页限流 %i 后恢复，只重试该页，每次尝试计量',
  async (errorCode) => {
    let failed = false;
    const { adapter, requests, transport } = wireSetup((body) => {
      if (body.page === 2 && !failed) {
        failed = true;
        return JSON.stringify({ error_response: { error_code: errorCode } });
      }
      return pageReply(body);
    });
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    await expect(govern(adapter, take).listOrders(win, {}, ctx)).resolves.toMatchObject({
      items: rows()
        .slice(100)
        .map((r) => expect.objectContaining({ order_id: r.order_sn })),
    });
    expect(requests.filter((body) => body.page === 1)).toHaveLength(1);
    expect(requests.filter((body) => body.page === 2)).toHaveLength(2);
    expect(take.mock.calls).toEqual(transport.mock.calls.map(() => ['order_sync']));
  },
);

it.each([52101, 70031])(
  '[AC-B1-04w-GOV#4] 第 2 页持续限流 %i 最终仍报 rate_limited，外层不再重试遍历',
  async (errorCode) => {
    const { adapter, requests, transport } = wireSetup((body) =>
      body.page === 2
        ? JSON.stringify({ error_response: { error_code: errorCode } })
        : pageReply(body),
    );
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    await expect(govern(adapter, take).listOrders(win, {}, ctx)).rejects.toMatchObject({
      code: 'rate_limited',
      platform: 'pdd',
    });
    expect(requests.filter((body) => body.page === 1)).toHaveLength(1);
    expect(requests.filter((body) => body.page === 2)).toHaveLength(3);
    expect(take).toHaveBeenCalledTimes(transport.mock.calls.length);
  },
);

it('[AC-B1-04w-GOV#5] 单页超时取消信号到达传输层，重试该页且不重放已成功页', async () => {
  const timer = new ManualScheduler();
  const signals: (AbortSignal | undefined)[] = [];
  const { adapter, requests, transport } = wireSetup((body, signal) => {
    if (body.page !== 2) return pageReply(body);
    signals.push(signal);
    return new Promise<string>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  const result = observe(govern(adapter, take, timer).listOrders(win, {}, ctx));
  await timer.advance(30_600);
  expect(result.settled).toBe('rejected');
  expect(result.error).toMatchObject({ code: 'timeout' });
  expect(signals).toHaveLength(3);
  expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
  expect(requests.filter((body) => body.page === 1)).toHaveLength(1);
  expect(take).toHaveBeenCalledTimes(transport.mock.calls.length);
  expect(timer.pending).toBe(0);
});

it('[AC-B1-04w-GOV#6] 逐请求能力不能仅看平台，未声明者和详情保留外层计量', async () => {
  const real = wireSetup((body) => pageReply(body));
  const demo = new DemoUnionAdapter({
    platform: 'pdd',
    environment: 'test',
    seed: 'quota-demo',
    clock: real.clock,
  });
  for (const raw of [basicAdapter('jd'), basicAdapter('taobao'), basicAdapter('pdd'), demo]) {
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    const outcome = await govern(raw, take)
      .listOrders(win, {}, ctx)
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({
          ok: false as const,
          code: error instanceof UnionError ? error.code : String(error),
        }),
      );
    if (raw === demo) {
      // Orchestrator ruling D-w1: the demo adapter's listOrders is adapter_unimplemented by design
      // (the demo order stream waits for order-sync); it still takes exactly one outer token.
      expect(outcome).toEqual({ ok: false, code: 'adapter_unimplemented' });
    } else {
      expect(outcome).toMatchObject({ ok: true });
      if (outcome.ok) expect(outcome.value).toHaveProperty('items');
    }
    expect(take.mock.calls).toEqual([['order_sync']]);
    const denied = vi.fn<QuotaLimiter['tryAcquire']>(() => false);
    await expect(govern(raw, denied).listOrders(win, {}, ctx)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    expect(denied).toHaveBeenCalledTimes(1);
  }
  // D-w1: only the adapter that declares per-request metering (the real pdd adapter) moves the
  // listOrders tokens inside: one token per upstream request instead of one per outer attempt.
  const declared = wireSetup((body) => pageReply(body));
  const perRequest = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  await govern(declared.adapter, perRequest).listOrders(win, {}, ctx);
  expect(declared.transport.mock.calls.length).toBeGreaterThan(1);
  expect(perRequest).toHaveBeenCalledTimes(declared.transport.mock.calls.length);
  for (const platform of ['jd', 'taobao', 'pdd'] as const) {
    const fail = vi.fn(async () => {
      throw new UnionError('rate_limited', 'synthetic', platform);
    });
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    await expect(
      govern({ ...basicAdapter(platform), listOrders: fail }, take).listOrders(win, {}, ctx),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(fail).toHaveBeenCalledTimes(3);
    expect(take).toHaveBeenCalledTimes(3);
  }
  const failingDetail = wireSetup((body) => {
    expect(body.type).toBe(detail);
    return JSON.stringify({ error_response: { error_code: 70031 } });
  });
  const detailTake = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  await expect(
    govern(failingDetail.adapter, detailTake).getPddOrderDetail!('synthetic-order', ctx),
  ).rejects.toMatchObject({ code: 'rate_limited' });
  expect(failingDetail.transport).toHaveBeenCalledTimes(3);
  expect(detailTake).toHaveBeenCalledTimes(3);
  // Declaring listOrders as internally governed also covers its single-request pay_time branch.
  const range = wireSetup(() =>
    JSON.stringify({ order_list_get_response: { order_list: [row()] } }),
  );
  const rangeTake = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  const rangePort = govern(range.adapter, rangeTake);
  await expect(rangePort.listOrders(win, { queryMode: 'pay_time' }, ctx)).resolves.toHaveProperty(
    'items',
  );
  expect(rangeTake.mock.calls).toEqual([['order_sync']]);
  expect(range.transport).toHaveBeenCalledTimes(1);
  rangeTake.mockImplementation(() => false);
  await expect(rangePort.listOrders(win, { queryMode: 'pay_time' }, ctx)).rejects.toMatchObject({
    code: 'quota_exceeded',
  });
  expect(range.transport).toHaveBeenCalledTimes(1);
  // The contrast with a real multi-request adapter makes this regression red on B1-04i.
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  await expect(collect(govern(real.adapter, take))).resolves.toEqual(expect.any(Array));
  expect(take).toHaveBeenCalledTimes(real.transport.mock.calls.length);
});

it('[AC-B1-04w-GOV#7] 若治理回调放在 CallCtx，包装层覆盖调用方同名字段', async () => {
  const { adapter, transport } = wireSetup((body) => pageReply(body));
  const original = adapter.listOrders.bind(adapter);
  let injected: CallCtx = ctx;
  vi.spyOn(adapter, 'listOrders').mockImplementation((window, options, call) => {
    injected = call;
    return original(window, options, call);
  });
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  const port = govern(adapter, take);
  await port.listOrders(win, {}, ctx);
  // Discover callback names, without prescribing a new interface or requiring a callback design.
  const poison = vi.fn(() => {
    expect.fail('caller-supplied governance callback was invoked');
  });
  const forged = Object.fromEntries(
    Object.entries(injected)
      .filter(([, value]) => typeof value === 'function')
      .map(([key]) => [key, poison]),
  );
  const caller = Object.freeze({ ...ctx, ...forged });
  await expect(port.listOrders(win, {}, caller)).resolves.toHaveProperty('items');
  expect(poison).not.toHaveBeenCalled();
  expect(take).toHaveBeenCalledTimes(transport.mock.calls.length);
  take.mockImplementation(() => false);
  const before = transport.mock.calls.length;
  await expect(port.listOrders(win, {}, caller)).rejects.toMatchObject({ code: 'quota_exceeded' });
  expect(transport).toHaveBeenCalledTimes(before);
});

it('[AC-B1-04w-GOV#8] 单页未超时的长遍历可完成，整次时长留给 order-sync 控制', async () => {
  const timer = new ManualScheduler();
  const { adapter, transport } = wireSetup(async (body, signal) => {
    await timer.sleep(6000, signal);
    return pageReply(body);
  });
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  const result = observe(govern(adapter, take, timer).listOrders(win, {}, ctx));
  await timer.advance(100_000);
  expect(result.settled).toBe('resolved');
  expect(result.value?.items.map((order) => order.order_id)).toEqual(
    rows()
      .slice(100)
      .map((r) => r.order_sn),
  );
  expect(take).toHaveBeenCalledTimes(transport.mock.calls.length);
  expect(timer.pending).toBe(0);
});

it('[AC-B1-04w-GOV#9] 当前页限流后配额耗尽，以本地 quota_exceeded 结束而不重放遍历', async () => {
  let remaining = 2;
  const { adapter, transport, requests } = wireSetup((body) =>
    body.page === 1 ? pageReply(body) : JSON.stringify({ error_response: { error_code: 52101 } }),
  );
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => remaining-- > 0);
  await expect(govern(adapter, take).listOrders(win, {}, ctx)).rejects.toMatchObject({
    code: 'quota_exceeded',
  });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(take).toHaveBeenCalledTimes(3);
  expect(requests.filter((body) => body.page === 1)).toHaveLength(1);
});
