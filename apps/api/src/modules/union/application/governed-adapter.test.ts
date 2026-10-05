import { expect, it } from 'vitest';
import type { QuotaLimiter, Scheduler } from '../../platform/index.ts';
import {
  createGovernedAdapter,
  makeUnionItem,
  UnionError,
  type CallCtx,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionErrorCode,
} from '../index.ts';

// Local unit-test identifiers; not AC-LINK / AC-ORD acceptance.
const online: CallCtx = { appId: 'app-a', requestId: 'req-1', purpose: 'online' };
const endpoint: UnionEndpoint = {
  platform: 'jd',
  mode: 'replay',
  baseUrl: 'http://wiremock:8080/jd',
  quotaKey: 'account:jd',
};
const quota: QuotaLimiter = { bucketKey: 'account:jd', tryAcquire: () => true };
/**
 * Time stands still: backoff waits (under the 3 s online timeout) resolve at once, the timeout
 * wait only ends when it is cancelled. Every attempt therefore falls in one breaker window.
 */
const scheduler: Scheduler = {
  now: () => 0,
  sleep: (ms, signal) =>
    ms < 3000
      ? Promise.resolve()
      : new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
};
const item = makeUnionItem(
  {
    platform: 'jd',
    itemId: 'item-A',
    skuId: null,
    title: 'unit',
    price_fen: '100',
    coupon_fen: '0',
    final_price_fen: '100',
    commission_percent: '1',
  },
  { now: () => new Date('2026-10-06T00:00:00Z') },
);

function failingAdapter(
  code: UnionErrorCode,
  outcome: () => 'throw' | 'ok' = () => 'throw',
): { adapter: UnionAdapter; attempts: () => number } {
  let attempts = 0;
  const read = async (): Promise<typeof item> => {
    attempts += 1;
    if (outcome() === 'throw') throw new UnionError(code, 'synthetic', 'jd');
    return item;
  };
  return {
    attempts: () => attempts,
    adapter: {
      platform: 'jd',
      searchItems: async () => ({ items: [await read()], nextCursor: null }),
      getItem: read,
      resolveLink: async () => ({ item: { platform: 'jd', itemId: 'item-A' } }),
      convert: async () => ({ kind: 'url', url: 'https://example.invalid/result' }),
      listOrders: async () => ({ items: [], nextCursor: null }),
    },
  };
}

it.each(['item_unavailable', 'link_unrecognized', 'upstream_rejected'] as const)(
  '[AC-B1-04b-UNIT#1] 业务拒绝 %s 不重试',
  async (code) => {
    const { adapter, attempts } = failingAdapter(code);
    const port = createGovernedAdapter(adapter, { endpoint, scheduler, quota });
    await expect(port.getItem({ platform: 'jd', itemId: 'item-A' }, online)).rejects.toMatchObject({
      code,
    });
    expect(attempts()).toBe(1);
  },
);

it.each(['upstream_unavailable', 'rate_limited'] as const)(
  '[AC-B1-04b-UNIT#2] 依赖故障 %s 按幂等读重试两次',
  async (code) => {
    const { adapter, attempts } = failingAdapter(code);
    const port = createGovernedAdapter(adapter, { endpoint, scheduler, quota });
    await expect(port.getItem({ platform: 'jd', itemId: 'item-A' }, online)).rejects.toMatchObject({
      code,
    });
    expect(attempts()).toBe(3);
  },
);

it('[AC-B1-04b-UNIT#3] 业务拒绝不计入熔断：大量拒绝之后调用仍到达适配器', async () => {
  let calls = 0;
  const { adapter } = failingAdapter('item_unavailable', () => (++calls <= 30 ? 'throw' : 'ok'));
  const port = createGovernedAdapter(adapter, { endpoint, scheduler, quota });
  for (let i = 0; i < 30; i += 1) {
    await expect(port.getItem({ platform: 'jd', itemId: 'item-A' }, online)).rejects.toMatchObject({
      code: 'item_unavailable',
    });
  }
  await expect(port.getItem({ platform: 'jd', itemId: 'item-A' }, online)).resolves.toBe(item);
});

it('[AC-B1-04b-UNIT#4] 依赖故障计入熔断：达到阈值后熔断', async () => {
  const { adapter, attempts } = failingAdapter('upstream_unavailable');
  const port = createGovernedAdapter(adapter, { endpoint, scheduler, quota });
  for (let i = 0; i < 7; i += 1) {
    await expect(port.getItem({ platform: 'jd', itemId: 'item-A' }, online)).rejects.toThrow();
  }
  const before = attempts();
  await expect(port.getItem({ platform: 'jd', itemId: 'item-A' }, online)).rejects.toMatchObject({
    code: 'circuit_open',
  });
  expect(attempts()).toBe(before);
});
