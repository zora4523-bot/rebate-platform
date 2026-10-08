import { expect, it } from 'vitest';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { APP, contaminated, dependencyErrors, memoryRedis, observed, searchCache } from './kit.ts';

it('[AC-B1-05g#1] 搜索 300000ms 命中、300001ms 重查；quoted_at 不续期且 age 由时钟增加', async () => {
  const f = searchCache();
  const first = await f.run();
  f.clock.advanceMs(299999);
  const before = await f.run();
  f.clock.advanceMs(1);
  const boundary = await f.run();
  expect(f.searchItems).toHaveBeenCalledTimes(1);
  expect(before.items[0]).toMatchObject({
    quoted_at: first.items[0]?.quoted_at,
    age_sec: 299,
    stale: false,
  });
  expect(boundary.items[0]).toMatchObject({
    quoted_at: first.items[0]?.quoted_at,
    age_sec: 300,
    stale: false,
  });
  f.clock.advanceMs(1);
  f.searchItems.mockResolvedValue({
    items: [
      { ...f.publicItem, title: 'synthetic refreshed', quoted_at: f.clock.now().toISOString() },
    ],
    nextCursor: null,
  });
  const refreshed = await f.run();
  expect(f.searchItems).toHaveBeenCalledTimes(2);
  expect(refreshed.items[0]).toMatchObject({
    title: 'synthetic refreshed',
    age_sec: 0,
    stale: false,
  });
});

it('[AC-B1-05g#2] fetched_at 从收到响应算起而非发起请求，物理 TTL 恒为 3600', async () => {
  const f = searchCache();
  f.searchItems.mockImplementation(async () => {
    f.clock.advanceMs(2500);
    return {
      items: [{ ...f.publicItem, quoted_at: f.clock.now().toISOString() }],
      nextCursor: null,
    };
  });
  await f.run();
  f.clock.advanceMs(300000);
  const result = await f.run();
  expect(f.searchItems).toHaveBeenCalledTimes(1);
  expect(result.items[0]).toMatchObject({ age_sec: 300 });
  expect(f.set.mock.calls.length).toBeGreaterThan(0);
  expect(f.set.mock.calls.every(([, , ttl]) => ttl === 3600)).toBe(true);
  expect([...f.rows.keys()].every((key) => key.startsWith(`${APP}:`))).toBe(true);
});

it('[AC-B1-05g#3] NFKC、空白合并和小写归一；不同用户设备共用原页但每次重报价重登记', async () => {
  const f = searchCache();
  f.quote.mockImplementation(async (_item, viewer, context) => ({
    rebateMinFen: viewer.userId === 'synthetic-v3' ? 80n : 10n,
    rebateMaxFen: viewer.userId === 'synthetic-v3' ? 80n : 10n,
    estNetPriceFen: null,
    rebateBasis: context?.rebateBasis ?? 'normal',
  }));
  const first = await f.run({ q: '  ＭＩＬＫ\t  Tea  ' });
  f.setViewer({ userId: 'synthetic-v3', deviceId: 'synthetic-new-device' });
  const second = await f.run({ q: 'milk tea' });
  f.setViewer({ userId: null, deviceId: 'synthetic-guest-device' });
  const third = await f.run({ q: 'milk tea' });
  expect(f.searchItems).toHaveBeenCalledTimes(1);
  expect(first.items[0]?.rebate_max_fen).toBe(10);
  expect(second.items[0]?.rebate_max_fen).toBe(80);
  expect(third.items[0]?.rebate_max_fen).toBe(10);
  expect(new Set([first, second, third].map((page) => page.items[0]?.link_id)).size).toBe(3);
  expect(f.quote).toHaveBeenCalledTimes(3);
  expect(f.register).toHaveBeenCalledTimes(3);
  expect(
    f.getActivePid.mock.calls.every(
      ([input]) => input.pidScene === 'query' && input.purpose === 'query',
    ),
  ).toBe(true);
  expect(JSON.stringify(f.searchItems.mock.calls)).not.toContain('relation_id');
});

it.each([
  { q: 'different milk' },
  { sort: 'sales_desc' as const },
  { has_coupon: true },
  { price_min_fen: 500 },
  { limit: 2 },
])('[AC-B1-05g#4] 搜索结果参数 %j 改变后单独缓存', async (change) => {
  const f = searchCache();
  await f.run();
  await f.run();
  await f.run(change);
  await f.run(change);
  expect(f.searchItems).toHaveBeenCalledTimes(2);
  expect(f.rows.size).toBe(2);
});

it('[AC-B1-05g#5] app、platform、filter_cfg_version 都隔离缓存', async () => {
  const f = searchCache();
  await f.run();
  await f.run();
  f.setViewer({ appId: 'synthetic_other' });
  await f.run();
  f.setViewer({ appId: APP });
  f.searchItems.mockResolvedValue({
    items: [{ ...f.publicItem, platform: 'jd', itemId: 'synthetic001' }],
    nextCursor: null,
  });
  await f.run({ platform: 'jd' });
  f.values.set('search.filter_cfg_version', 'synthetic-v2');
  f.searchItems.mockResolvedValue({ items: [f.publicItem], nextCursor: null });
  await f.run();
  expect(f.searchItems).toHaveBeenCalledTimes(4);
  expect(f.rows.size).toBe(4);
});

it('[AC-B1-05g#6] 搜索缓存移除全部链接、口令与个人报价，键不含归因或请求者', async () => {
  const f = searchCache();
  f.searchItems.mockResolvedValue({ items: [contaminated(f.publicItem)], nextCursor: null });
  await f.run();
  expect(f.rows.size).toBe(1);
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
    'user_id',
    'relation_id',
    'example.test',
  ]) {
    expect(stored).not.toContain(forbidden);
  }
  const keys = [...f.rows.keys()].join('\n');
  for (const forbidden of [
    'synthetic-query-pid',
    'synthetic-user',
    'synthetic-device',
    'synthetic-relation',
    'synthetic-session',
  ])
    expect(keys).not.toContain(forbidden);
  const second = await f.run();
  expect(second.items[0]).toMatchObject({ final_price_fen: 1000 });
  expect(f.searchItems).toHaveBeenCalledTimes(1);
});

it.each([
  ...dependencyErrors(),
  ...(['timeout', 'circuit_open', 'quota_exceeded'] as const).map(
    (code) => new GovernanceError(code, 'union.search', 'synthetic dependency failure'),
  ),
])(
  '[AC-B1-05g#7] %s 仅允许窗口内旧页并标 stale，超出 1ms 返回 50304 且不取物料',
  async (failure) => {
    const f = searchCache();
    f.values.set('search.cache_ttl_sec', 1);
    const first = await f.run();
    f.searchItems.mockRejectedValue(failure);
    f.clock.advanceMs(300000);
    const cached = await observed(() => f.run());
    expect(cached).toMatchObject({
      kind: 'returned',
      value: { items: [{ stale: true, age_sec: 300, quoted_at: first.items[0]?.quoted_at }] },
    });
    f.clock.advanceMs(1);
    expect(await observed(() => f.run())).toMatchObject({
      kind: 'rejected',
      error: { code: 50304, data: { platform: 'taobao' } },
    });
    expect(f.materialFeed).not.toHaveBeenCalled();
  },
);

it.each([
  new UnionError('item_unavailable', 'synthetic off shelf', 'taobao'),
  new UnionError('upstream_rejected', 'synthetic refusal', 'taobao'),
  new GovernanceError('invalid_policy', 'union.search', 'synthetic invalid policy'),
])('[AC-B1-05g#8] 业务拒绝 %s 不得返回旧页', async (failure) => {
  const f = searchCache();
  f.values.set('search.cache_ttl_sec', 1);
  await f.run();
  f.clock.advanceMs(1001);
  f.searchItems.mockRejectedValue(failure);
  expect(await observed(() => f.run())).toMatchObject({ kind: 'rejected', error: failure });
  expect(f.materialFeed).not.toHaveBeenCalled();
});

it.each(['absent', 'get', 'set'] as const)(
  '[AC-B1-05g#9] Redis %s 时直读联盟，不把缓存故障作为搜索故障',
  async (mode) => {
    const memory = memoryRedis();
    if (mode !== 'absent') memory.fail(mode);
    const f = searchCache(memory, mode !== 'absent');
    const first = await observed(() => f.run());
    const second = await observed(() => f.run());
    expect(first).toMatchObject({ kind: 'returned', value: { items: [{ stale: false }] } });
    expect(second).toMatchObject({ kind: 'returned', value: { items: [{ stale: false }] } });
    expect(f.searchItems).toHaveBeenCalledTimes(2);
  },
);

it('[AC-B1-05g#10] 冷缓存的联盟故障返回 50304 与 platform，不冒充空页或物料', async () => {
  const f = searchCache();
  f.searchItems.mockRejectedValue(dependencyErrors()[0]);
  expect(await observed(() => f.run())).toMatchObject({
    kind: 'rejected',
    error: { code: 50304, data: { platform: 'taobao' } },
  });
  expect(f.materialFeed).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it.each([120, 3600])(
  '[AC-B1-05g#26] 熔断降级使用配置的 stale 窗口 %s 秒，不能由物理存活代替判断',
  async (seconds) => {
    const f = searchCache();
    f.values.set('search.cache_ttl_sec', 1);
    f.values.set('search.cache.stale_max_age_s', seconds);
    const first = await f.run();
    f.searchItems.mockRejectedValue(
      new GovernanceError('circuit_open', 'union.search', 'synthetic circuit'),
    );
    f.clock.advanceMs(seconds * 1000);
    expect(await observed(() => f.run())).toMatchObject({
      kind: 'returned',
      value: {
        items: [{ stale: true, quoted_at: first.items[0]?.quoted_at, age_sec: seconds }],
      },
    });
    f.clock.advanceMs(1);
    expect(await observed(() => f.run())).toMatchObject({
      kind: 'rejected',
      error: { code: 50304 },
    });
    expect(f.materialFeed).not.toHaveBeenCalled();
  },
);

it('[AC-B1-05g#27] 推广位与附带归因、身份、我方游标变化不产生新的搜索缓存条目', async () => {
  const f = searchCache();
  const request = {
    appId: APP,
    platform: 'taobao' as const,
    keyword: 'synthetic milk',
    pageNo: 1,
    pageSize: 1,
    sort: 'relevance' as const,
    promotionSlot: 'synthetic-query-pid',
    user_id: 'synthetic-first',
    device_id: 'synthetic-device-a',
    relation_id: 'synthetic-relation-a',
    search_session_id: 'synthetic-session-a',
    cursor: 'synthetic-our-cursor-a',
  };
  await f.upstream.search(request);
  await f.upstream.search({ ...request, promotionSlot: 'synthetic-new-query-pid' });
  const other = {
    ...request,
    user_id: 'synthetic-second',
    device_id: 'synthetic-device-b',
    relation_id: 'synthetic-relation-b',
    search_session_id: 'synthetic-session-b',
    cursor: 'synthetic-our-cursor-b',
  };
  await f.upstream.search(other);
  expect(f.searchItems).toHaveBeenCalledTimes(1);
  expect(f.rows.size).toBe(1);
});
