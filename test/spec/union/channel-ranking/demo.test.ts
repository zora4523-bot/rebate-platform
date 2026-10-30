// The demo adapter (non-prod only, 规划/11 §4.5) answers material-channel calls with deterministic
// synthetic data: the same input gives the same result, pages neither repeat nor skip positions,
// hasMore is exact, salesText is a string or null, and every item comes from the demo's existing
// catalog (the same DTO its material feed returns). Never a capability claim (CAP-*-10).
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  DemoUnionAdapter,
  createUnionChannelRanking,
  createUnionRegistry,
  isRegisteredPlatform,
  type CallCtx,
  type ChannelRankingCategory,
  type ChannelRankingEntry,
  type ChannelRankingPage,
  type ChannelRankingReq,
  type ItemRef,
  type RegisteredPlatform,
  type UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';
import { NOW, channel } from './kit.ts';

const SEED = 'synthetic-rank-seed';
const CHANNEL = 'synthetic-demo-sales';
const ctx: CallCtx = {
  appId: 'synthetic-demo-app',
  requestId: 'synthetic-demo-request',
  purpose: 'online',
};
const platforms = ['taobao', 'jd', 'pdd'] as const;
/** Upper bound of a walk; the demo catalog is far smaller. */
const MAX_PAGES = 200;

function demo(platform: RegisteredPlatform): DemoUnionAdapter {
  return new DemoUnionAdapter({
    platform,
    seed: SEED,
    clock: new FixedClock(NOW),
    environment: 'test',
  });
}

function keyOf(ref: ItemRef): string {
  return JSON.stringify([
    ref.platform,
    ref.item_id ?? null,
    ref.itemId ?? null,
    ref.skuId ?? null,
    ref.goods_id ?? null,
    ref.goods_sign ?? null,
  ]);
}

/** Every item of the demo's material feed: the demo catalog as UnionItem DTOs. */
async function feedCatalog(adapter: DemoUnionAdapter): Promise<Map<string, UnionItem>> {
  const items = new Map<string, UnionItem>();
  let cursor: string | undefined;
  for (let turn = 0; turn < MAX_PAGES; turn++) {
    const page = await adapter.materialFeed(cursor === undefined ? {} : { cursor }, ctx);
    for (const feedItem of page.items) items.set(keyOf(feedItem), feedItem);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
  }
  throw new Error('demo material feed did not end');
}

type Fetch = (req: ChannelRankingReq) => Promise<ChannelRankingPage>;

/** Pages 1.. until hasMore=false; every page checked against the size and hasMore rules. */
async function walk(
  fetch: Fetch,
  categoryId: string | null,
  pageSize: number,
): Promise<ChannelRankingEntry[]> {
  const all: ChannelRankingEntry[] = [];
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    const page = await fetch({ channelId: CHANNEL, categoryId, pageNo, pageSize });
    expect(page.items.length, `page ${String(pageNo)} is not empty while walking`).toBeGreaterThan(
      0,
    );
    expect(page.items.length).toBeLessThanOrEqual(pageSize);
    all.push(...page.items);
    if (!page.hasMore) {
      const after = await fetch({ channelId: CHANNEL, categoryId, pageNo: pageNo + 1, pageSize });
      expect(after, 'the page after the last one is empty').toEqual({ items: [], hasMore: false });
      return all;
    }
    expect(page.items.length, 'a page with more after it is full').toBe(pageSize);
  }
  throw new Error('demo channel ranking did not end');
}

function fetchOf(adapter: DemoUnionAdapter): Fetch {
  return (req) => adapter.channelRanking(req, ctx);
}

it.each(platforms)(
  '[AC-B1-22p#21] demo %s：类目确定（同种子两个实例、两次调用结果相同），非空，标识唯一、名称非空',
  async (platform) => {
    const first = await demo(platform).channelCategories({ channelId: CHANNEL }, ctx);
    const again = await demo(platform).channelCategories({ channelId: CHANNEL }, ctx);
    expect(again).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
    const ids = first.map((category: ChannelRankingCategory) => category.categoryId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const category of first) {
      expect(Object.keys(category).sort()).toEqual(['categoryId', 'name']);
      expect(category.categoryId.trim()).not.toBe('');
      expect(category.name.trim()).not.toBe('');
    }
  },
);

it.each(platforms)(
  '[AC-B1-22p#22] demo %s：整榜与各类目分页不重不漏，hasMore 准确，换页大小走完的顺序完全相同',
  async (platform) => {
    const adapter = demo(platform);
    const categories = await adapter.channelCategories({ channelId: CHANNEL }, ctx);
    for (const categoryId of [null, ...categories.map((category) => category.categoryId)]) {
      const byFive = await walk(fetchOf(adapter), categoryId, 5);
      const keys = byFive.map((position) => keyOf(position.item));
      expect(new Set(keys).size, 'no position repeats').toBe(keys.length);
      const bySeven = await walk(fetchOf(adapter), categoryId, 7);
      expect(bySeven).toEqual(byFive);
      const whole = await walk(fetchOf(adapter), categoryId, 50);
      expect(whole).toEqual(byFive);
    }
  },
);

it.each(platforms)(
  '[AC-B1-22p#23] demo %s：同入参同结果（跨实例），pageSize 被遵守',
  async (platform) => {
    const req: ChannelRankingReq = { channelId: CHANNEL, categoryId: null, pageNo: 2, pageSize: 3 };
    const first = await demo(platform).channelRanking(req, ctx);
    const again = await demo(platform).channelRanking(req, ctx);
    expect(again).toEqual(first);
    const one = await demo(platform).channelRanking({ ...req, pageNo: 1, pageSize: 1 }, ctx);
    expect(one.items).toHaveLength(1);
    expect(one.hasMore).toBe(true);
  },
);

it.each(platforms)(
  '[AC-B1-22p#24] demo %s：榜单商品都来自 demo 现有商品集（与物料流同一 DTO），salesText 为字符串或 null',
  async (platform) => {
    const adapter = demo(platform);
    const catalog = await feedCatalog(adapter);
    const positions = await walk(fetchOf(adapter), null, 50);
    for (const position of positions) {
      expect(Object.keys(position).sort()).toEqual(['item', 'salesText']);
      expect(position.item.platform).toBe(platform);
      expect(catalog.get(keyOf(position.item)), 'an item of the demo catalog').toEqual(
        position.item,
      );
      expect(position.salesText === null || typeof position.salesText === 'string').toBe(true);
    }
  },
);

it('[AC-B1-22p#25][BR-TEXT-17] 经端口取 demo 登记表（非 prod）的白名单频道：与直接调 demo 的结果相同，重复取结果不变', async () => {
  const clock = new FixedClock(NOW);
  const registry = createUnionRegistry({
    endpoints: platforms.map((platform) => ({
      platform,
      mode: 'demo' as const,
      baseUrl: null,
      quotaKey: `synthetic:${platform}`,
    })),
    environment: 'test',
    seed: SEED,
    clock,
  });
  const port = createUnionChannelRanking({
    adapterFor: (platform) => (isRegisteredPlatform(platform) ? registry.get(platform) : undefined),
    channels: () => ({ version: 'synthetic-demo', channels: [channel('jd', CHANNEL)] }),
    callCtx: (input) => ({ appId: input.appId, requestId: 'synthetic-demo', purpose: 'online' }),
    logger: { warn: () => undefined },
  });
  const input = {
    appId: ctx.appId,
    platform: 'jd' as const,
    channelId: CHANNEL,
    categoryId: null,
    pageNo: 1,
    pageSize: 10,
  };
  const viaPort = await port.page(input);
  expect(await port.page(input)).toEqual(viaPort);
  const direct = await demo('jd').channelRanking(
    { channelId: CHANNEL, categoryId: null, pageNo: 1, pageSize: 10 },
    ctx,
  );
  expect(viaPort).toEqual(direct);
  expect(viaPort.items.length).toBeGreaterThan(0);
  expect(await port.categories({ appId: ctx.appId, platform: 'jd', channelId: CHANNEL })).toEqual(
    await demo('jd').channelCategories({ channelId: CHANNEL }, ctx),
  );
});
