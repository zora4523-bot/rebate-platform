import { expect, it, vi } from 'vitest';
import type { QuotaLimiter } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  UnionAdapter,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/index.ts';
import type { UpstreamGate } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { ManualScheduler, observe } from '../../platform/http/kit.ts';
import { response, setup } from '../jd-core/kit.ts';
import {
  collect,
  ctx,
  govern,
  inner,
  num,
  pageAnswer,
  reply,
  singleRowPages,
  win,
  wire,
} from './kit.ts';

// 每一次上游翻页都单独经配额治理（B1-04w 的教训）：一页一次配额、单页超时与重试，本地配额拒绝结束整次遍历。
const { pages, ids } = singleRowPages(4);

const throttles: readonly [string, () => UnionTransportResponse][] = [
  ['网关 code 2', () => response({ error_response: { code: '2' } })],
  ['网关 code 429', () => response({ error_response: { code: '429' } })],
  ['内层 code 429', () => reply(inner([], false, num('429')))],
];

it('[AC-B1-04zb#16] 适配器声明 listOrdersMetering = per_request', () => {
  const adapter: UnionAdapter = setup().adapter;
  expect(adapter.listOrdersMetering).toBe('per_request');
});

it('[AC-B1-04zb#17] 每页发送前恰扣一次配额（用途 order_sync），取消信号是该次尝试的', async () => {
  const events: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const answer = pageAnswer(pages);
  const { adapter, requests } = wire((body, signal) => {
    events.push(`request:${String(body.pageIndex)}`);
    signals.push(signal);
    return answer(body);
  });
  const take = vi.fn<QuotaLimiter['tryAcquire']>((purpose) => {
    events.push(`quota:${purpose}`);
    return true;
  });
  const { orders } = await collect(govern(adapter, take));
  expect(orders.map((order) => order.sub_order_id)).toEqual(ids);
  expect(requests.map((body) => body.pageIndex)).toEqual([1, 2, 3, 4]);
  expect(events).toEqual(
    requests.flatMap((body) => ['quota:order_sync', `request:${String(body.pageIndex)}`]),
  );
  expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  expect(new Set(signals).size).toBe(4);
});

it.each([1, 2, 3])(
  '[AC-B1-04zb#18] 配额只够 %i 次时传输层恰收到这么多次，以 quota_exceeded 结束，不重试、不从第 1 页重来、不计故障',
  async (budget) => {
    let remaining = budget;
    const { adapter, requests, transport } = wire(pageAnswer(pages));
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => remaining-- > 0);
    const port = govern(adapter, take);
    await expect(collect(port)).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(transport).toHaveBeenCalledTimes(budget);
    expect(requests.map((body) => body.pageIndex)).toEqual(
      Array.from({ length: budget }, (_, i) => i + 1),
    );
    expect(take).toHaveBeenCalledTimes(budget + 1);
    // Same governor: local refusals must not read as upstream failures and open the breaker.
    for (let i = 0; i < 25; i += 1) {
      await expect(port.listOrders(win, {}, ctx)).rejects.toMatchObject({ code: 'quota_exceeded' });
    }
    expect(transport).toHaveBeenCalledTimes(budget);
    remaining = 20;
    const { orders } = await collect(port);
    expect(orders.map((order) => order.sub_order_id)).toEqual(ids);
  },
);

it.each(throttles)(
  '[AC-B1-04zb#19] 第 2 页限流（%s）后恢复：只重试该页，每次尝试都计配额',
  async (_name, throttle) => {
    let failed = false;
    const answer = pageAnswer(pages);
    const { adapter, requests, transport } = wire((body) => {
      if (body.pageIndex === 2 && !failed) {
        failed = true;
        return throttle();
      }
      return answer(body);
    });
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    const { orders } = await collect(govern(adapter, take));
    expect(orders.map((order) => order.sub_order_id)).toEqual(ids);
    expect(requests.map((body) => body.pageIndex)).toEqual([1, 2, 2, 3, 4]);
    expect(take).toHaveBeenCalledTimes(transport.mock.calls.length);
  },
);

it.each(throttles)(
  '[AC-B1-04zb#20] 第 2 页持续限流（%s）：该页重试用尽报 rate_limited，外层不重放遍历',
  async (_name, throttle) => {
    const answer = pageAnswer(pages);
    const { adapter, requests, transport } = wire((body) =>
      body.pageIndex === 2 ? throttle() : answer(body),
    );
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    await expect(collect(govern(adapter, take))).rejects.toMatchObject({
      code: 'rate_limited',
      platform: 'jd',
    });
    expect(requests.map((body) => body.pageIndex)).toEqual([1, 2, 2, 2]);
    expect(take).toHaveBeenCalledTimes(transport.mock.calls.length);
  },
);

it('[AC-B1-04zb#21] 当前页限流后配额耗尽，以本地 quota_exceeded 结束，已成功的页不重放', async () => {
  let remaining = 2;
  const answer = pageAnswer(pages);
  const { adapter, requests } = wire((body) =>
    body.pageIndex === 1 ? answer(body) : reply(inner([], false, num('429'))),
  );
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => remaining-- > 0);
  await expect(collect(govern(adapter, take))).rejects.toMatchObject({ code: 'quota_exceeded' });
  expect(requests.map((body) => body.pageIndex)).toEqual([1, 2]);
  expect(take).toHaveBeenCalledTimes(3);
});

it('[AC-B1-04zb#22] 单页超时：取消信号到达传输层，只重试该页，已成功的页不重放', async () => {
  const timer = new ManualScheduler();
  const signals: (AbortSignal | undefined)[] = [];
  const answer = pageAnswer(pages);
  const { adapter, requests, transport } = wire((body, signal) => {
    if (body.pageIndex !== 2) return answer(body);
    signals.push(signal);
    return new Promise<UnionTransportResponse>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  const result = observe(collect(govern(adapter, take, timer)));
  await timer.advance(30_600);
  expect(result.settled).toBe('rejected');
  expect(result.error).toMatchObject({ code: 'timeout' });
  expect(signals).toHaveLength(3);
  expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
  expect(requests.filter((body) => body.pageIndex === 1)).toHaveLength(1);
  expect(take).toHaveBeenCalledTimes(transport.mock.calls.length);
  expect(timer.pending).toBe(0);
});

it('[AC-B1-04zb#23] 单页不超时的长遍历能走完：整次时长留给 order-sync，不套外层超时', async () => {
  const timer = new ManualScheduler();
  const answer = pageAnswer(pages);
  const { adapter, transport } = wire(async (body, signal) => {
    await timer.sleep(6000, signal);
    return answer(body);
  });
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  const result = observe(collect(govern(adapter, take, timer)));
  await timer.advance(100_000);
  expect(result.settled).toBe('resolved');
  expect(result.value?.orders.map((order) => order.sub_order_id)).toEqual(ids);
  expect(take).toHaveBeenCalledTimes(transport.mock.calls.length);
  expect(timer.pending).toBe(0);
});

it.each(['2002452', '2002453'])(
  '[AC-B1-04zb#24] 内层 %s → upstream_rejected：不重试、不计故障、不自行缩窗',
  async (code) => {
    const answer = pageAnswer(pages);
    const { adapter, requests } = wire((body) =>
      body.pageIndex === 2 ? reply(inner([], false, num(code))) : answer(body),
    );
    await expect(collect(adapter)).rejects.toMatchObject({
      code: 'upstream_rejected',
      platform: 'jd',
    });
    expect(requests.map((body) => body.pageIndex)).toEqual([1, 2]);
    expect(requests[1]).toMatchObject({ startTime: requests[0]!.startTime });
    expect(requests[1]).toMatchObject({ endTime: requests[0]!.endTime });

    const governed = wire(() => reply(inner([], false, num(code))));
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    const port = govern(governed.adapter, take);
    for (let i = 0; i < 25; i += 1) {
      await expect(port.listOrders(win, {}, ctx)).rejects.toMatchObject({
        code: 'upstream_rejected',
      });
    }
    expect(governed.transport).toHaveBeenCalledTimes(25);
    expect(take).toHaveBeenCalledTimes(25);
  },
);

it('[AC-B1-04zb#25] 调用方伪造的 gateUpstream 被包装层换掉，翻页不绕过配额', async () => {
  const { adapter, transport } = wire(pageAnswer(pages));
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  const forged = vi.fn(() => {
    throw new Error('forged gate must not run');
  });
  const caller = { ...ctx, gateUpstream: forged as unknown as UpstreamGate };
  const { orders } = await collect(govern(adapter, take), win, {}, caller);
  expect(orders.map((order) => order.sub_order_id)).toEqual(ids);
  expect(forged).not.toHaveBeenCalled();
  expect(take).toHaveBeenCalledTimes(transport.mock.calls.length);
});

it('[AC-B1-04zb#26] 调用方取消后不再翻下一页', async () => {
  const controller = new AbortController();
  const answer = pageAnswer(pages);
  const { adapter, transport } = wire((body) => {
    controller.abort(new Error('synthetic stop'));
    return answer(body);
  });
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  const caller = { ...ctx, signal: controller.signal };
  await expect(collect(govern(adapter, take), win, {}, caller)).rejects.toThrow('synthetic stop');
  expect(transport).toHaveBeenCalledTimes(1);
  expect(take).toHaveBeenCalledTimes(1);
});
