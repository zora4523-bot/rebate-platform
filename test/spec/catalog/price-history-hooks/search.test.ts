// B1-17c: the search hook (BR-WATCH-19 (1), source_kind search). searchProducts gets the
// recorder as options.priceHistory; a page is a fresh union return only when it carries
// fresh: true (a cache hit has no flag, a stale entry has stale: true).
import { expect, it } from 'vitest';
import {
  searchProducts,
  type SearchCandidate,
  type SearchProductsQuery,
} from '../../../../apps/api/src/modules/catalog/search.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { QUERY, candidate, fixture } from '../search/kit.ts';
import { byKey, hangingRecorder, hookRecorder, outcome, textOf, throwingRecorder } from './kit.ts';

function anomaly(name: string): SearchCandidate {
  const base = candidate(name);
  return { ...base, item: { ...base.item, price_status: 'anomaly' } };
}

it('[AC-B1-17c#1] 搜索：联盟新鲜返回的每个候选各交出一条 search 观测（字段逐项，不含查看者与推广位），写入器写入', async () => {
  const f = fixture();
  const hook = hookRecorder(f.clock);
  f.pages.set(1, {
    items: [candidate('a', 1000n, 200n), candidate('b', 1500n)],
    hasMore: false,
    fresh: true,
  });
  const data = await searchProducts(QUERY, { ...f.options, priceHistory: hook.recorder });
  expect(data.items).toHaveLength(2);
  await hook.recorder.drain();
  expect(byKey(hook.observations)).toEqual([
    {
      appId: 'synthetic-app',
      platform: 'taobao',
      productKey: 'tb:synthetic-a',
      skuKey: null,
      sourceKind: 'search',
      outcome: 'ok',
      priceFen: 1200n,
      couponFen: 200n,
      finalPriceFen: 1000n,
      priceStatus: 'ok',
      inStock: true,
      fresh: true,
      userScoped: false,
      goodsSignPlan: null,
    },
    {
      appId: 'synthetic-app',
      platform: 'taobao',
      productKey: 'tb:synthetic-b',
      skuKey: null,
      sourceKind: 'search',
      outcome: 'ok',
      priceFen: 1500n,
      couponFen: 0n,
      finalPriceFen: 1500n,
      priceStatus: 'ok',
      inStock: true,
      fresh: true,
      userScoped: false,
      goodsSignPlan: null,
    },
  ]);
  const text = textOf(hook.observations);
  expect(text).not.toContain('synthetic-user');
  expect(text).not.toContain('synthetic-device');
  expect(text).not.toContain('synthetic-query-pid');
  expect(byKey(hook.writes).map((row) => [row.productKey, row.sourceKind])).toEqual([
    ['tb:synthetic-a', 'search'],
    ['tb:synthetic-b', 'search'],
  ]);
});

it('[AC-B1-17c#2] 搜索：缓存命中页与 stale 页不落库，只有新鲜返回页写入', async () => {
  const f = fixture();
  const hook = hookRecorder(f.clock);
  const options = { ...f.options, priceHistory: hook.recorder };
  f.pages.set(1, { items: [candidate('a', 1000n)], hasMore: false, fresh: true });
  await searchProducts(QUERY, options);
  await hook.recorder.drain();
  expect(hook.writes.map((row) => row.productKey)).toEqual(['tb:synthetic-a']);
  const handedFresh = hook.observations.length;

  // A cache hit: the same page without the fresh flag.
  f.pages.set(1, { items: [candidate('a', 1000n)], hasMore: false });
  await searchProducts(QUERY, options);
  // A stale entry served on a union outage.
  f.pages.set(1, { items: [candidate('a', 1000n)], hasMore: false, stale: true });
  await searchProducts(QUERY, options);
  await hook.recorder.drain();

  expect(hook.writes.map((row) => row.productKey)).toEqual(['tb:synthetic-a']);
  expect(hook.observations.slice(handedFresh).every((row) => row.fresh === false)).toBe(true);
});

it('[AC-B1-17c#3] 搜索：价格异常与拼多多（统一 DTO 无 goods_sign 计划）不落库，同页正常候选照写', async () => {
  const f = fixture();
  const hook = hookRecorder(f.clock);
  const options = { ...f.options, priceHistory: hook.recorder };
  f.pages.set(1, {
    items: [candidate('a', 1000n), anomaly('x')],
    hasMore: false,
    fresh: true,
  });
  await searchProducts(QUERY, options);
  f.pages.set(1, {
    items: [candidate('p', 900n, 0n, 'pdd')],
    hasMore: false,
    fresh: true,
  });
  const pdd: SearchProductsQuery = { ...QUERY, platform: 'pdd' };
  await searchProducts(pdd, options);
  await hook.recorder.drain();
  expect(hook.writes.map((row) => row.productKey)).toEqual(['tb:synthetic-a']);
  expect(
    hook.observations
      .filter((row) => row.platform === 'pdd')
      .every((row) => row.goodsSignPlan === null),
  ).toBe(true);
});

it('[AC-B1-17c#4] 搜索：上游失败时错误与未装配钩子逐项一致，失败查询不落库', async () => {
  const runs = [fixture(), fixture()];
  const hook = hookRecorder(runs[1]!.clock);
  const results = [];
  for (const [index, f] of runs.entries()) {
    const options = index === 0 ? f.options : { ...f.options, priceHistory: hook.recorder };
    f.pages.set(1, { items: [candidate('a', 1000n)], hasMore: false, fresh: true });
    const ok = await outcome(() => searchProducts(QUERY, options));
    f.search.mockRejectedValueOnce(new UnionError('upstream_unavailable', 'synthetic outage'));
    const failed = await outcome(() => searchProducts(QUERY, options));
    results.push({ ok, failed });
  }
  await hook.recorder.drain();
  expect(results[0]!.failed).toMatchObject({ kind: 'rejected', error: { code: 50304 } });
  expect(results[1]).toEqual(results[0]);
  expect(hook.writes.map((row) => row.productKey)).toEqual(['tb:synthetic-a']);
});

it('[AC-B1-17c#5] 搜索：记录器抛错或 record 永不返回时，响应与未装配钩子逐项一致（交出即返回、不 await）', async () => {
  const runs = [fixture(), fixture(), fixture()];
  const throwing = throwingRecorder();
  const hanging = hangingRecorder();
  const recorders = [undefined, throwing.recorder, hanging.recorder];
  const results = [];
  for (const [index, f] of runs.entries()) {
    f.pages.set(1, {
      items: [candidate('a', 1000n, 200n), candidate('b', 1500n)],
      hasMore: false,
      fresh: true,
    });
    const recorder = recorders[index];
    const options = recorder === undefined ? f.options : { ...f.options, priceHistory: recorder };
    results.push(await outcome(() => searchProducts(QUERY, options)));
  }
  expect(results[0]).toMatchObject({ kind: 'returned' });
  expect(results[1]).toEqual(results[0]);
  expect(results[2]).toEqual(results[0]);
  expect(throwing.record).toHaveBeenCalledTimes(2);
  expect(hanging.record).toHaveBeenCalledTimes(2);
}, 5000);
