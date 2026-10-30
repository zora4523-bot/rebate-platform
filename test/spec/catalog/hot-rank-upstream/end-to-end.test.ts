// B1-28j: the wiring under B1-28h's use case and cache. getHotRank over createUnionHotRankUpstream
// lists the channel's positions in the channel's order with sales_text as is; behind
// cacheHotRankUpstream the same request a second time reaches no adapter (rank.cache_ttl_seconds,
// B1-28h, unchanged). The demo adapter is served through the same wiring, never a platform
// payload.
import { deriveProductKey } from '@couli/domain';
import { expect, it } from 'vitest';
import { createUnionHotRankUpstream } from '../../../../apps/api/src/modules/catalog/infra/hot-rank-wiring.ts';
import {
  DemoUnionAdapter,
  type CallCtx,
  type RegisteredPlatform,
  type UnionAdapter,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP,
  JD_CHANNEL,
  PDD_CHANNEL,
  TB_CHANNEL,
  fixture,
  hotRank,
  memoryRedis,
  pageRequest,
  position,
  tbItem,
} from './kit.ts';

it('[AC-B1-28j#23][BR-TEXT-17] 经 getHotRank：接口条目按频道顺序、sales_text 原样（含 null），hasMore 时给 next_cursor', async () => {
  const f = fixture();
  f.fake('taobao').setPage({
    items: [
      position(tbItem('c', 3, { commissionBp: 9_000n }), '3万+'),
      position(tbItem('a', 1, { commissionBp: 100n }), null),
      position(tbItem('b', 2, { commissionBp: 5_000n }), ' 月销 2 件'),
    ],
    hasMore: true,
  });

  const data = await hotRank(f)();

  expect(data.channel).toBe(TB_CHANNEL);
  expect(data.items.map((item) => [item.product_card.title, item.sales_text])).toEqual([
    ['synthetic-c', '3万+'],
    ['synthetic-a', null],
    ['synthetic-b', ' 月销 2 件'],
  ]);
  expect(data.items.map((item) => item.product_card.product_key)).toEqual(['tb:3', 'tb:1', 'tb:2']);
  expect(data.next_cursor).not.toBeNull();
});

it('[AC-B1-28j#24] 经 getHotRank 翻到第二页：wiring 向 channelRanking 要的是第 2 页、同一频道与类目、每页 20', async () => {
  const f = fixture();
  f.fake('taobao').setCategories([{ categoryId: 'synthetic-cat', name: '合成类目' }]);
  f.fake('taobao').setPage({ items: [position(tbItem('a', 1), '1')], hasMore: true });
  const run = hotRank(f);

  const first = await run({ category: 'synthetic-cat' });
  expect(first.next_cursor).not.toBeNull();
  await run({ category: 'synthetic-cat', cursor: first.next_cursor! });

  expect(f.fake('taobao').rankingCalls.map((call) => call.req)).toEqual([
    { channelId: TB_CHANNEL, categoryId: 'synthetic-cat', pageNo: 1, pageSize: 20 },
    { channelId: TB_CHANNEL, categoryId: 'synthetic-cat', pageNo: 2, pageSize: 20 },
  ]);
});

it('[AC-B1-28j#25] 缓存仍生效：cacheHotRankUpstream(createUnionHotRankUpstream(...)) 同一请求第二次不再调 adapter，答案相同', async () => {
  const f = fixture();
  f.fake('taobao').setCategories([{ categoryId: 'synthetic-cat', name: '合成类目' }]);
  f.fake('taobao').setPage({
    items: [position(tbItem('a', 1), '1件'), position(tbItem('b', 2), null)],
    hasMore: false,
  });
  const memory = memoryRedis();
  const run = hotRank(f, { redis: memory.redis });

  const first = await run();
  const calls = f.channelCalls();
  expect(calls).toBeGreaterThan(0);
  expect(memory.rows.size).toBeGreaterThan(0);

  const second = await run();

  expect(f.channelCalls()).toBe(calls);
  expect(second.items.map((item) => [item.product_card.product_key, item.sales_text])).toEqual(
    first.items.map((item) => [item.product_card.product_key, item.sales_text]),
  );
  expect(second.categories).toEqual(first.categories);
});

it('[AC-B1-28j#26] 缓存口径不变：超过 rank.cache_ttl_seconds 后再次请求会重新经 wiring 取数', async () => {
  const f = fixture();
  f.settings.set('rank.cache_ttl_seconds', 60);
  f.fake('taobao').setPage({ items: [position(tbItem('a', 1), '1')], hasMore: false });
  const run = hotRank(f, { redis: memoryRedis().redis });

  await run();
  const calls = f.fake('taobao').rankingCalls.length;
  f.clock.advanceMs(61_000);
  await run();

  expect(f.fake('taobao').rankingCalls.length).toBe(calls + 1);
});

/** The demo adapter of one platform, seen by the wiring as the governed union's adapter. */
function demoFixture(platform: RegisteredPlatform) {
  const f = fixture();
  const demo = new DemoUnionAdapter({
    platform,
    seed: 'synthetic-rank-seed',
    clock: f.clock,
    environment: 'test',
  });
  const options = { ...f.options, union: { adapter: (): UnionAdapter => demo } };
  return { f, demo, options };
}

const DEMO_CHANNELS: Readonly<Record<RegisteredPlatform, string>> = {
  taobao: TB_CHANNEL,
  jd: JD_CHANNEL,
  pdd: PDD_CHANNEL,
};
const PREFIXES: Readonly<Record<RegisteredPlatform, string>> = {
  taobao: 'tb',
  jd: 'jd',
  pdd: 'pdd',
};

it('[AC-B1-28j#27] 演示环境：wiring 经演示适配器取类目与榜单，与演示适配器同一请求的答案逐项同序，salesText、hasMore 原样，ref 按 deriveProductKey', async () => {
  for (const platform of ['taobao', 'jd', 'pdd'] as const) {
    const { f, demo, options } = demoFixture(platform);
    const upstream = createUnionHotRankUpstream(options);
    const channelId = DEMO_CHANNELS[platform];
    const ctx: CallCtx = { appId: APP, requestId: 'synthetic-direct', purpose: 'online' };
    const directCategories = await demo.channelCategories({ channelId }, ctx);
    const direct = await demo.channelRanking(
      { channelId, categoryId: null, pageNo: 1, pageSize: 20 },
      ctx,
    );
    expect(direct.items.length, platform).toBeGreaterThan(0);

    const categories = await upstream.categories({ appId: APP, platform, channelId });
    const page = await upstream.page(pageRequest({ platform, channelId }));

    expect(categories).toEqual(directCategories);
    expect(page.items.map((entry) => [entry.item, entry.salesText])).toEqual(
      direct.items.map((entry) => [entry.item, entry.salesText]),
    );
    const derivation = {
      platform,
      keyPrefix: PREFIXES[platform],
      ...(platform === 'jd' ? { jdMode: 'item' as const } : {}),
    };
    expect(page.items.map((entry) => entry.ref.productKey)).toEqual(
      direct.items.map((entry) => deriveProductKey(derivation, entry.item)),
    );
    expect(page.hasMore).toBe(direct.hasMore);
    expect(f.warnings).toEqual([]);
  }
});
