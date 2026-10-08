import { expect, it, vi } from 'vitest';
import { createCatalogProductReader } from '../../../../apps/api/src/modules/catalog/application/product-reader.ts';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP_ID,
  PRODUCT_KEY,
  RAW_ID,
  contaminated,
  dependencyErrors,
  detailCache,
  memoryRedis,
  observed,
} from './kit.ts';

it('[AC-B1-05g#11] 详情 300000ms 命中沿用 quoted_at，300001ms 重查，仍每次登记新 link', async () => {
  const f = detailCache();
  const first = await f.get();
  f.clock.advanceMs(300000);
  const second = await f.get();
  expect(second).toMatchObject({ quoted_at: first.quoted_at, age_sec: 300, stale: false });
  expect(second.link_id).not.toBe(first.link_id);
  expect(f.getItem).toHaveBeenCalledTimes(1);
  expect(f.quote).toHaveBeenCalledTimes(2);
  expect(f.register).toHaveBeenCalledTimes(2);
  expect(f.set.mock.calls.map(([, , ttl]) => ttl)).toEqual([3600]);
  const keys = [...f.rows.keys()];
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatch(new RegExp(`^${APP_ID}:`));
  expect(keys[0]).toContain(PRODUCT_KEY);
  expect(keys[0]).not.toContain(RAW_ID);
  f.clock.advanceMs(1);
  await f.get();
  expect(f.getItem).toHaveBeenCalledTimes(2);
});

it.each([
  ...dependencyErrors(),
  ...(['timeout', 'circuit_open', 'quota_exceeded'] as const).map(
    (code) => new GovernanceError(code, 'union.detail', 'synthetic detail failure'),
  ),
])('[AC-B1-05g#12] 详情 %s 只回窗口内 stale，超窗仍为 50401', async (failure) => {
  const f = detailCache();
  f.values.set('search.cache_ttl_sec', 1);
  const first = await f.get();
  f.clock.advanceMs(300000);
  f.getItem.mockRejectedValue(failure);
  expect(await observed(() => f.get())).toMatchObject({
    kind: 'returned',
    value: { stale: true, age_sec: 300, quoted_at: first.quoted_at },
  });
  f.clock.advanceMs(1);
  expect(await observed(() => f.get())).toMatchObject({ kind: 'rejected', error: { code: 50401 } });
});

it('[AC-B1-05g#13] 详情下架与业务拒绝不回旧缓存，不掩盖原错误', async () => {
  const f = detailCache();
  f.values.set('search.cache_ttl_sec', 1);
  await f.get();
  f.clock.advanceMs(1001);
  f.getItem.mockRejectedValue(new UnionError('item_unavailable', 'synthetic off shelf', 'taobao'));
  expect(await observed(() => f.get())).toMatchObject({ kind: 'rejected', error: { code: 30141 } });
  f.getItem.mockRejectedValue(
    new GovernanceError('invalid_policy', 'union.detail', 'synthetic policy'),
  );
  expect(await observed(() => f.get())).toMatchObject({
    kind: 'rejected',
    error: { code: 'invalid_policy' },
  });
});

it('[AC-B1-05g#14] 无 product_refs 的两条链接取标题共享详情缓存，不写 refs', async () => {
  const f = detailCache();
  const readProductRef = vi.fn(async () => null);
  const reader = createCatalogProductReader({
    refs: { readProductRef },
    upstream: f.upstream,
    config: f.config,
  });
  const query = { appId: APP_ID, platform: 'taobao', productKey: PRODUCT_KEY, rawItemId: RAW_ID };
  const first = await reader.read(query);
  // A different landing link's snapshot carries another raw reference for the same product.
  const otherReader = createCatalogProductReader({
    refs: { readProductRef },
    upstream: f.makeUpstream(),
    config: f.config,
  });
  const second = await otherReader.read({
    ...query,
    rawItemId: 'synthetic-second-prefix-synthetic001',
  });
  expect(first.title).toBe('合成详情商品');
  expect(second).toEqual(first);
  expect(f.getItem).toHaveBeenCalledTimes(1);
  expect(f.registerProductRef).not.toHaveBeenCalled();
  // The actual detail use case must consume this same entry, not a separate private cache.
  const detail = await f.get();
  expect(detail.title).toBe(first.title);
  expect(f.getItem).toHaveBeenCalledTimes(1);
});

it('[AC-B1-05g#15] 详情按 app/product_key 隔离，raw_id 改变不改键，缓存不含链接或报价', async () => {
  const f = detailCache();
  const base = await f.getItem(
    { platform: 'taobao', item_id: RAW_ID },
    { appId: APP_ID, requestId: 'synthetic', purpose: 'online' },
  );
  f.getItem.mockClear();
  f.getItem.mockImplementation(async (ref) =>
    contaminated({ ...base, item_id: ref.item_id ?? RAW_ID }),
  );
  const request = {
    appId: APP_ID,
    productKey: PRODUCT_KEY,
    platform: 'taobao' as const,
    rawItemId: RAW_ID,
  };
  await f.upstream.detail(request);
  await f.upstream.detail({ ...request, rawItemId: 'synthetic-other-prefix-synthetic001' });
  await f.upstream.detail({ ...request, appId: 'synthetic_other' });
  await f.upstream.detail({
    ...request,
    productKey: 'tb:synthetic002',
    rawItemId: 'synthetic-prefix-synthetic002',
  });
  expect(f.getItem).toHaveBeenCalledTimes(3);
  expect(f.rows.size).toBe(3);
  const stored = [...f.rows.values()].join('\n');
  for (const forbidden of [
    'coupon_share_url',
    'click_url',
    '"url"',
    '_tpwd',
    'rebate_min_fen',
    'rebate_max_fen',
    'est_net_price_fen',
    'link_id',
    'relation_id',
    'user_id',
    'example.test',
  ])
    expect(stored).not.toContain(forbidden);
});

it.each(['absent', 'get', 'set'] as const)(
  '[AC-B1-05g#16] 详情 Redis %s 时两次都直读联盟并正常成卡',
  async (mode) => {
    const memory = memoryRedis();
    if (mode !== 'absent') memory.fail(mode);
    const f = detailCache(memory, mode !== 'absent');
    expect(await observed(() => f.get())).toMatchObject({
      kind: 'returned',
      value: { stale: false },
    });
    expect(await observed(() => f.get())).toMatchObject({
      kind: 'returned',
      value: { stale: false },
    });
    expect(f.getItem).toHaveBeenCalledTimes(2);
  },
);
