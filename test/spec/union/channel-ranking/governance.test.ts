// In production the port gets the governed adapter (same path as materialFeed; 规划/02 §6.2), so
// the governance wrapper must keep channelCategories / channelRanking when the adapter has them
// (absent otherwise), run them under governance with the configured base URL and a fresh signal,
// call the adapter itself as `this`, and never reach it when the quota refuses.
import { expect, it } from 'vitest';
import type { QuotaLimiter, Scheduler } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createGovernedAdapter,
  type CallCtx,
  type UnionAdapter,
  type UnionEndpoint,
} from '../../../../apps/api/src/modules/union/index.ts';
import { JD_CHANNEL, SECRET, ctxFor, fakeAdapter } from './kit.ts';

// No wall-clock waits: backoff resolves at once, a timeout waits only for its cancellation.
const scheduler: Scheduler = {
  now: () => 0,
  sleep: (ms, signal) =>
    ms < 3000
      ? Promise.resolve()
      : new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
};
const endpoint: UnionEndpoint = {
  platform: 'jd',
  mode: 'live',
  baseUrl: 'https://jd.invalid/router',
  quotaKey: 'synthetic:jd',
};

function govern(raw: UnionAdapter, take: QuotaLimiter['tryAcquire'] = () => true): UnionAdapter {
  return createGovernedAdapter(raw, {
    endpoint,
    scheduler,
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: take },
  });
}

const caller: CallCtx = Object.freeze({
  ...ctxFor('synthetic-gov-app', 'jd'),
  baseUrl: 'https://untrusted.invalid',
});

it('[AC-B1-22p#26] 治理包装保留适配器的 channelCategories / channelRanking；适配器没有时包装上也没有', () => {
  const capable = govern(fakeAdapter('jd').adapter);
  expect(capable.channelCategories).toBeTypeOf('function');
  expect(capable.channelRanking).toBeTypeOf('function');
  const bare = govern(fakeAdapter('jd', false).adapter);
  expect(bare.channelCategories).toBeUndefined();
  expect(bare.channelRanking).toBeUndefined();
});

it('[AC-B1-22p#27] 治理包装下的 channelRanking：原样传请求、以原适配器为 this、换上配置的 URL 与新的 signal，取一个配额令牌，结果原样返回', async () => {
  const fake = fakeAdapter('jd');
  const purposes: string[] = [];
  const governed = govern(fake.adapter, (purpose) => {
    purposes.push(purpose);
    return true;
  });
  const method = governed.channelRanking;
  expect(method).toBeTypeOf('function');
  const req = { channelId: JD_CHANNEL, categoryId: 'synthetic-cat-a', pageNo: 2, pageSize: 20 };
  const result = await method!.call(governed, req, caller);
  expect(result.items.map((position) => position.item.title)).toEqual([
    'synthetic-first',
    'synthetic-second',
  ]);
  expect(fake.rankingCalls).toHaveLength(1);
  const call = fake.rankingCalls[0]!;
  expect(call.req).toEqual(req);
  expect(call.self).toBe(fake.adapter);
  expect(call.ctx).toMatchObject({
    appId: caller.appId,
    requestId: caller.requestId,
    purpose: 'online',
    baseUrl: endpoint.baseUrl,
    signal: expect.any(AbortSignal),
    headers: {},
  });
  expect(JSON.stringify(call.ctx.headers)).not.toContain(SECRET);
  expect(purposes).toEqual(['online']);
});

it('[AC-B1-22p#28] 治理包装下的 channelCategories：原样传请求、以原适配器为 this、换上配置的 URL 与新的 signal，取一个配额令牌', async () => {
  const fake = fakeAdapter('jd');
  const purposes: string[] = [];
  const governed = govern(fake.adapter, (purpose) => {
    purposes.push(purpose);
    return true;
  });
  const method = governed.channelCategories;
  expect(method).toBeTypeOf('function');
  const result = await method!.call(governed, { channelId: JD_CHANNEL }, caller);
  expect(result.map((category) => category.categoryId)).toEqual([
    'synthetic-cat-b',
    'synthetic-cat-a',
  ]);
  expect(fake.categoryCalls).toHaveLength(1);
  const call = fake.categoryCalls[0]!;
  expect(call.req).toEqual({ channelId: JD_CHANNEL });
  expect(call.self).toBe(fake.adapter);
  expect(call.ctx).toMatchObject({
    appId: caller.appId,
    purpose: 'online',
    baseUrl: endpoint.baseUrl,
    signal: expect.any(AbortSignal),
    headers: {},
  });
  expect(purposes).toEqual(['online']);
});

it('[AC-B1-22p#29] 配额拒绝时两个频道方法都不绕过治理直达适配器：quota_exceeded', async () => {
  const fake = fakeAdapter('jd');
  const governed = govern(fake.adapter, () => false);
  const categories = governed.channelCategories;
  const ranking = governed.channelRanking;
  expect(categories).toBeTypeOf('function');
  expect(ranking).toBeTypeOf('function');
  await expect(categories!.call(governed, { channelId: JD_CHANNEL }, caller)).rejects.toMatchObject(
    { code: 'quota_exceeded' },
  );
  await expect(
    ranking!.call(
      governed,
      { channelId: JD_CHANNEL, categoryId: null, pageNo: 1, pageSize: 20 },
      caller,
    ),
  ).rejects.toMatchObject({ code: 'quota_exceeded' });
  expect(fake.channelCalls()).toBe(0);
});
