// B1-05w: a detail with no fresh raw ID takes BR-PROD-05 ③ for every key, not only a pooled one
// (编排 12:06 ③ 第 1～6 条). Order item_ref → product_refs → re-parse; 重新解析步骤 1、2、3、4; 结果分类
// ①②③; no row to take a title from is 30143 without asking the union.
import { expect, it } from 'vitest';
import {
  RedisUnavailableError,
  type RedisNamespace,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { DemoUnionError, UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { APP_ID, NOW, PRODUCT_KEY, RAW_ID, item } from '../detail/kit.ts';
import { rejection } from '../hot-rank/kit.ts';
import {
  AGED,
  CANONICAL_URL,
  FRESH_MS,
  HANG_LIMIT_MS,
  NEW_RAW,
  POOL_FINAL_FEN,
  POOL_QUOTED_AT,
  POOL_TITLE,
  STORED_RAW,
  STORED_TITLE,
  agoIso,
  askedRaws,
  found,
  hang,
  onePage,
  outages,
  reparseFixture,
  unionCalls,
  within,
  type ReparseFixture,
} from './kit.ts';

const ONLINE = { appId: APP_ID, purpose: 'online' };
/** Long enough for a real 3 s timeout, a little of the fallback after it and the slack around. */
const TIMEOUT_CASE_MS = HANG_LIMIT_MS + 5000;
const THREE_SECONDS_FLOOR_MS = 2900;

function expectNoCard(f: ReparseFixture): void {
  expect(f.rows).toEqual([]);
  expect(f.register).not.toHaveBeenCalled();
  expect(f.quote).not.toHaveBeenCalled();
}

function expectWritten(f: ReparseFixture, raw: string = NEW_RAW): void {
  expect(f.registerProductRef).toHaveBeenCalledWith(
    expect.objectContaining({ appId: APP_ID, productKey: PRODUCT_KEY, rawItemId: raw }),
    expect.anything(),
  );
}

// ---------------------------------------------------------------------------------------------
// Order of the raw ID and which keys take step ③.

it('[B1-05w#1][BR-PROD-05] 没有池行的 key：item_ref、product_refs 都过期 → online 按 title 搜同平台，用新原串 getItem，正常卡 stale=false，product_refs 和链接记新原串', async () => {
  const f = reparseFixture();
  const tapped = f.issue({ fetchedAt: AGED });

  const card = await f.run({ item_ref: tapped });

  expect(card).toMatchObject({
    product_key: PRODUCT_KEY,
    final_price_fen: 2990,
    stale: false,
    availability: 'ok',
  });
  expect(card.item_ref).not.toBe(tapped);
  expect(f.searchItems).toHaveBeenCalledTimes(1);
  expect(f.searchItems.mock.calls[0]?.[0]).toMatchObject({ keyword: STORED_TITLE });
  expect(f.searchItems.mock.calls[0]?.[1]).toMatchObject(ONLINE);
  expect(f.getItem.mock.calls.map(([ref]) => ref)).toEqual([
    { platform: 'taobao', item_id: NEW_RAW },
  ]);
  expect(f.getItem.mock.calls[0]?.[1]).toMatchObject(ONLINE);
  expectWritten(f);
  expect(f.rows[0]?.ref.rawItemId).toBe(NEW_RAW);
});

it('[B1-05w#2][BR-PROD-05] 顺序不变：item_ref 恰好 1800 秒用它的原串，不读 product_refs、不重解析', async () => {
  const f = reparseFixture();

  await f.run({ item_ref: f.issue({ fetchedAt: agoIso(FRESH_MS) }) });

  expect(askedRaws(f.fake)).toEqual([RAW_ID]);
  expect(f.readProductRef).not.toHaveBeenCalled();
  expect(f.searchItems).not.toHaveBeenCalled();
  expect(f.resolveLink).not.toHaveBeenCalled();
});

it('[B1-05w#3][BR-PROD-05] 顺序不变：product_refs 恰好 1800 秒用它的原串，不重解析', async () => {
  const f = reparseFixture({ stored: { receivedAt: agoIso(FRESH_MS) } });

  await f.run();

  expect(askedRaws(f.fake)).toEqual([STORED_RAW]);
  expect(f.searchItems).not.toHaveBeenCalled();
  expect(f.resolveLink).not.toHaveBeenCalled();
});

it('[B1-05w#4][BR-PROD-05] product_refs 过期 1 毫秒 → 重解析，过期原串一次都不问', async () => {
  const f = reparseFixture({ stored: { receivedAt: agoIso(FRESH_MS + 1) } });

  await f.run();

  expect(f.searchItems).toHaveBeenCalledTimes(1);
  expect(askedRaws(f.fake)).toEqual([NEW_RAW]);
});

it('[B1-05w#5][BR-PROD-05] product_refs 行和合格池行都在：标题取 product_refs 的', async () => {
  const f = reparseFixture({ pooled: true });

  await f.run();

  expect(f.searchItems.mock.calls[0]?.[0]).toMatchObject({ keyword: STORED_TITLE });
});

it('[B1-05w#6][BR-PROD-05] 没有 product_refs 行、有合格池行：标题取池行的', async () => {
  const f = reparseFixture({ stored: null, pooled: true });

  const card = await f.run();

  expect(card).toMatchObject({ stale: false, final_price_fen: 2990 });
  expect(f.searchItems.mock.calls[0]?.[0]).toMatchObject({ keyword: POOL_TITLE });
  expectWritten(f);
});

it('[B1-05w#7][BR-PROD-05] 编排第 4 条：既没有 product_refs 行也没有合格池行 → 30143，没有标题可搜，不问联盟', async () => {
  const f = reparseFixture({ stored: null });

  expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

  expect(f.readProductRef).toHaveBeenCalled();
  expect(unionCalls(f.fake)).toBe(0);
  expectNoCard(f);
});

it('[B1-05w#8][BR-PROD-05] 编排第 4 条：item_ref 过期也一样，令牌里的原串不算行', async () => {
  const f = reparseFixture({ stored: null });

  const failure = await rejection(() => f.run({ item_ref: f.issue({ fetchedAt: AGED }) }));

  expect(failure).toMatchObject({ code: 30143 });
  expect(unionCalls(f.fake)).toBe(0);
});

// ---------------------------------------------------------------------------------------------
// 重新解析步骤 1: canonical_url.

it('[B1-05w#9][BR-PROD-05] 步骤 1：有 canonical_url 先按链接解析，online，不搜标题，新原串 getItem 并写 product_refs', async () => {
  const f = reparseFixture({ stored: { canonicalUrl: CANONICAL_URL } });

  const card = await f.run();

  expect(card).toMatchObject({ stale: false, final_price_fen: 2990 });
  expect(f.resolveLink.mock.calls.map(([url]) => url)).toEqual([CANONICAL_URL]);
  expect(f.resolveLink.mock.calls[0]?.[1]).toMatchObject(ONLINE);
  expect(f.searchItems).not.toHaveBeenCalled();
  expect(askedRaws(f.fake)).toEqual([NEW_RAW]);
  expectWritten(f);
});

it.each([
  { label: '派生出别的键', linked: { platform: 'taobao', item_id: 'synthetic-renewed-other002' } },
  { label: '派生不出键', linked: { platform: 'taobao', item_id: null } },
] as const)(
  '[B1-05w#10][BR-PROD-05] 步骤 1：链接解析$label → 30143，不再搜标题、不 getItem',
  async ({ linked }) => {
    const f = reparseFixture({ stored: { canonicalUrl: CANONICAL_URL } });
    f.resolveLink.mockResolvedValue({ item: linked });

    expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

    expect(f.searchItems).not.toHaveBeenCalled();
    expect(f.getItem).not.toHaveBeenCalled();
    expect(f.registerProductRef).not.toHaveBeenCalled();
    expectNoCard(f);
  },
);

// ---------------------------------------------------------------------------------------------
// 重新解析步骤 2: the title search of the first page.

function pageWith(position: number, nextCursor: string | null = null) {
  const items = Array.from({ length: 25 }, (_unused, index) =>
    index + 1 === position ? found() : item({ item_id: `synthetic-other${String(index + 1)}` }),
  );
  return { items, nextCursor };
}

it('[B1-05w#11][BR-PROD-05] 步骤 2：目标在第 20 条找得到', async () => {
  const f = reparseFixture();
  f.searchItems.mockResolvedValue(pageWith(20));

  await f.run();

  expect(askedRaws(f.fake)).toEqual([NEW_RAW]);
});

it('[B1-05w#12][BR-PROD-05] 步骤 2：只看第 1 页前 20 条，第 21 条的目标不算，不翻页 → 30143', async () => {
  const f = reparseFixture();
  f.searchItems.mockResolvedValue(pageWith(21, 'synthetic-next'));

  expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

  expect(f.searchItems).toHaveBeenCalledTimes(1);
  expect(f.getItem).not.toHaveBeenCalled();
  expectNoCard(f);
});

it('[B1-05w#13][BR-PROD-05] 步骤 2：UnionItem 没有 shop_id，靠精确比对键：别的平台、别的键都跳过，取派生等于目标键的条目', async () => {
  const f = reparseFixture();
  f.searchItems.mockResolvedValue(
    onePage([
      item({ platform: 'jd', item_id: null, itemId: 'other_synthetic001_tail' }),
      item({ item_id: 'synthetic-renewed-other002' }),
      item({ item_id: null }),
      found(),
    ]),
  );

  await f.run();

  expect(askedRaws(f.fake)).toEqual([NEW_RAW]);
});

it.each([
  {
    label: '京东 item 模式',
    productKey: 'jd:i_synthetic001',
    jdMode: 'item',
    platform: 'jd',
    hit: item({
      platform: 'jd',
      item_id: null,
      itemId: 'renewed_synthetic001_tail',
      skuId: 'synthetic_other_sku',
    }),
    ref: { platform: 'jd', itemId: 'renewed_synthetic001_tail' },
  },
  {
    label: '京东 sku 模式',
    productKey: 'jd:synthetic_sku',
    jdMode: 'sku',
    platform: 'jd',
    hit: item({
      platform: 'jd',
      item_id: null,
      itemId: 'renewed_other002_tail',
      skuId: 'synthetic_sku',
    }),
    ref: { platform: 'jd', skuId: 'synthetic_sku' },
  },
  {
    label: '拼多多',
    productKey: 'pdd:synthetic001',
    jdMode: 'item',
    platform: 'pdd',
    hit: item({
      platform: 'pdd',
      item_id: null,
      goods_id: 'synthetic001',
      goods_sign: 'synthetic-renewed-sign',
    }),
    ref: { platform: 'pdd', goods_sign: 'synthetic-renewed-sign' },
  },
] as const)(
  '[B1-05w#14][BR-PROD-05] 适用所有 key：$label 按平台字段取新原串，product_key 不变',
  async ({ productKey, jdMode, platform, hit, ref }) => {
    const f = reparseFixture({ productKey, jdMode, stored: { platform } });
    f.searchItems.mockResolvedValue(onePage([hit]));
    f.getItem.mockResolvedValue(hit);

    const card = await f.run();

    expect(card).toMatchObject({ product_key: productKey, stale: false });
    expect(f.getItem.mock.calls.map(([asked]) => asked)).toEqual([ref]);
  },
);

it('[B1-05w#15][BR-PROD-05] 同键但没有原串的条目不算找到 → 30143，不拼原串', async () => {
  const f = reparseFixture({
    productKey: 'pdd:synthetic001',
    stored: { platform: 'pdd' },
  });
  f.searchItems.mockResolvedValue(
    onePage([item({ platform: 'pdd', item_id: null, goods_id: 'synthetic001', goods_sign: null })]),
  );

  expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

  expect(f.getItem).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------------------------
// 重新解析步骤 4 and 结果分类.

it('[B1-05w#16][BR-PROD-05] 步骤 4：解析成功先写 product_refs，再 getItem；refreshed_at 取解析响应的接收时刻', async () => {
  const f = reparseFixture();
  f.searchItems.mockImplementation(async () => {
    f.clock.advanceMs(2000);
    return onePage();
  });
  f.getItem.mockImplementation(async () => {
    expectWritten(f);
    f.clock.advanceMs(2000);
    return found();
  });

  await f.run();

  expect(f.getItem).toHaveBeenCalledTimes(1);
  expect(Date.parse(f.registerProductRef.mock.calls[0]![0].receivedAt)).toBe(
    Date.parse(NOW) + 2000,
  );
});

it.each(['第一页没有结果', '第一页只有别的键'])(
  '[B1-05w#17][BR-PROD-05] 结果分类②：%s → 30143，不用池价，不写 product_refs，不问详情',
  async (label) => {
    const f = reparseFixture({ pooled: true });
    const items = label === '第一页没有结果' ? [] : [item({ item_id: 'synthetic-other002' })];
    f.searchItems.mockResolvedValue(onePage(items));

    expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

    expect(f.getItem).not.toHaveBeenCalled();
    expect(f.registerProductRef).not.toHaveBeenCalled();
    expectNoCard(f);
  },
);

it('[B1-05w#18][BR-PROD-05] 结果分类②：不删详情缓存', async () => {
  const f = reparseFixture({ cached: true });
  await f.warmCache();
  const entries = [...f.memory.rows.entries()];
  expect(entries).toHaveLength(1);
  f.clock.advanceMs(300_000);
  f.searchItems.mockResolvedValue(onePage([]));

  expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

  expect([...f.memory.rows.entries()]).toEqual(entries);
});

it('[B1-05w#19][BR-PROD-05] 编排第 5 条：平台没有标题搜索（adapter_unimplemented）按找不到同键 → 30143，不问详情，不写 product_refs', async () => {
  const f = reparseFixture();
  f.searchItems.mockRejectedValue(
    new UnionError('adapter_unimplemented', 'synthetic: no title search', 'taobao'),
  );

  expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

  expect(f.getItem).not.toHaveBeenCalled();
  expect(f.registerProductRef).not.toHaveBeenCalled();
  expectNoCard(f);
});

it('[B1-05w#20][BR-PROD-05] 结果分类②：链接解析时联盟认不出链接 → 30143，不是暂时失败', async () => {
  const f = reparseFixture({ stored: { canonicalUrl: CANONICAL_URL }, pooled: true });
  f.resolveLink.mockRejectedValue(
    new UnionError('link_unrecognized', 'synthetic unknown link', 'taobao'),
  );

  expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

  expectNoCard(f);
});

it.each([
  new UnionError('item_unavailable', 'synthetic off shelf', 'taobao'),
  new DemoUnionError('demo_delisted', 'synthetic off shelf', 'taobao'),
])(
  '[B1-05w#21][BR-PROD-05] 结果分类①：新原串 getItem 答下架（%s）→ 30141，不用池价',
  async (error) => {
    const f = reparseFixture({ pooled: true });
    f.getItem.mockRejectedValue(error);

    expect(await rejection(() => f.run())).toMatchObject({ code: 30141 });

    expectNoCard(f);
  },
);

it.each([
  new UnionError('item_unavailable', 'synthetic off shelf', 'taobao'),
  new DemoUnionError('demo_delisted', 'synthetic off shelf', 'taobao'),
])('[B1-05w#22][BR-PROD-05] 结果分类①：链接解析答下架（%s）→ 30141，不搜标题', async (error) => {
  const f = reparseFixture({ stored: { canonicalUrl: CANONICAL_URL } });
  f.resolveLink.mockRejectedValue(error);

  expect(await rejection(() => f.run())).toMatchObject({ code: 30141 });

  expect(f.searchItems).not.toHaveBeenCalled();
  expect(f.getItem).not.toHaveBeenCalled();
  expectNoCard(f);
});

it.each(outages())(
  '[B1-05w#23][BR-PROD-05][BR-PRICE-11] 结果分类③：标题搜索 $label、没有旧缓存也没有合格池行 → 50401，不是 30143，不写 product_refs，不用过期原串',
  async ({ error }) => {
    const f = reparseFixture();
    f.searchItems.mockRejectedValue(error);

    expect(await rejection(() => f.run())).toMatchObject({ code: 50401 });

    expect(f.getItem).not.toHaveBeenCalled();
    expect(f.registerProductRef).not.toHaveBeenCalled();
    expectNoCard(f);
  },
);

it.each(outages())(
  '[B1-05w#24][BR-PROD-05][BR-PRICE-11] 结果分类③：链接解析 $label、都没有 → 50401',
  async ({ error }) => {
    const f = reparseFixture({ stored: { canonicalUrl: CANONICAL_URL } });
    f.resolveLink.mockRejectedValue(error);

    expect(await rejection(() => f.run())).toMatchObject({ code: 50401 });

    expect(f.getItem).not.toHaveBeenCalled();
    expectNoCard(f);
  },
);

it.each(outages())(
  '[B1-05w#25][BR-PROD-05][BR-PRICE-11] 结果分类③：解析成功、getItem $label、都没有 → 50401，新原串已写进 product_refs',
  async ({ error }) => {
    const f = reparseFixture();
    f.getItem.mockRejectedValue(error);

    expect(await rejection(() => f.run())).toMatchObject({ code: 50401 });

    expectWritten(f);
    expect(askedRaws(f.fake)).toEqual([NEW_RAW]);
    expectNoCard(f);
  },
);

it.each(outages())(
  '[B1-05w#26][BR-PRICE-11][TRADE-12] 结果分类③：$label 时没有旧缓存、有合格池行 → 池价 stale=true，quoted_at 取池行，不写 product_refs',
  async ({ error }) => {
    const f = reparseFixture({ pooled: true });
    f.searchItems.mockRejectedValue(error);

    const card = await f.run();

    expect(card).toMatchObject({ stale: true, final_price_fen: POOL_FINAL_FEN });
    expect(Date.parse(card.quoted_at!)).toBe(Date.parse(POOL_QUOTED_AT));
    expect(f.registerProductRef).not.toHaveBeenCalled();
  },
);

it.each(outages())(
  '[B1-05w#27][BR-PRICE-11][BR-PROD-07] 结果分类③：$label 时先用旧缓存：有合格池行也不用池价，stale=true，价格和 quoted_at 取缓存条目',
  async ({ error }) => {
    const f = reparseFixture({ cached: true, pooled: true });
    await f.warmCache();
    f.searchItems.mockRejectedValue(error);

    const card = await f.run();

    expect(f.searchItems).toHaveBeenCalled();
    expect(card).toMatchObject({ stale: true, final_price_fen: 2990 });
    expect(Date.parse(card.quoted_at!)).toBe(Date.parse(NOW));
  },
);

// ---------------------------------------------------------------------------------------------
// 重新解析步骤 3: one call at most 3 s; a call past it is a temporary failure.

it(
  '[B1-05w#28][BR-PROD-05] 步骤 3：标题搜索不返回 → 3 秒超时，按暂时失败 50401',
  async () => {
    const f = reparseFixture();
    f.searchItems.mockImplementation(hang);

    const started = performance.now();
    const ended = await within(HANG_LIMIT_MS, () => f.run());

    expect(ended).toMatchObject({ state: 'rejected', error: { code: 50401 } });
    expect(performance.now() - started).toBeGreaterThanOrEqual(THREE_SECONDS_FLOOR_MS);
    expect(f.getItem).not.toHaveBeenCalled();
    expectNoCard(f);
  },
  TIMEOUT_CASE_MS,
);

it(
  '[B1-05w#29][BR-PROD-05] 步骤 3：链接解析不返回 → 3 秒超时，按暂时失败 50401',
  async () => {
    const f = reparseFixture({ stored: { canonicalUrl: CANONICAL_URL } });
    f.resolveLink.mockImplementation(hang);

    const started = performance.now();
    const ended = await within(HANG_LIMIT_MS, () => f.run());

    expect(ended).toMatchObject({ state: 'rejected', error: { code: 50401 } });
    expect(performance.now() - started).toBeGreaterThanOrEqual(THREE_SECONDS_FLOOR_MS);
    expect(f.searchItems).not.toHaveBeenCalled();
  },
  TIMEOUT_CASE_MS,
);

it(
  '[B1-05w#30][BR-PROD-05][TRADE-12] 步骤 3：超时也是暂时失败：有合格池行 → 池价 stale=true',
  async () => {
    const f = reparseFixture({ pooled: true });
    f.searchItems.mockImplementation(hang);

    const ended = await within(HANG_LIMIT_MS, () => f.run());

    expect(ended).toMatchObject({
      state: 'resolved',
      value: { stale: true, final_price_fen: POOL_FINAL_FEN },
    });
  },
  TIMEOUT_CASE_MS,
);

it(
  '[B1-05w#31][BR-PROD-05][BR-PROD-07] 步骤 3：超时也是暂时失败：有旧缓存先用旧缓存',
  async () => {
    const f = reparseFixture({ cached: true, pooled: true });
    await f.warmCache();
    f.searchItems.mockImplementation(hang);

    const ended = await within(HANG_LIMIT_MS, () => f.run());

    expect(ended).toMatchObject({
      state: 'resolved',
      value: { stale: true, final_price_fen: 2990 },
    });
  },
  TIMEOUT_CASE_MS,
);

// ---------------------------------------------------------------------------------------------
// 重新解析步骤 3: without Redis nothing is locked and the re-parse goes on.

function unavailableRedis(): RedisNamespace {
  const down = () => Promise.reject(new RedisUnavailableError('command_failed'));
  return { get: down, set: down, eval: down };
}

it('[B1-05w#32][BR-PROD-05] 编排第 2 条：没有 Redis 不加锁，并发两个请求都照常解析出卡', async () => {
  const f = reparseFixture({ redis: null });

  const cards = await Promise.all([f.run(), f.run()]);

  expect(cards).toMatchObject([{ stale: false }, { stale: false }]);
  expect(f.searchItems).toHaveBeenCalled();
  expect(new Set(askedRaws(f.fake))).toEqual(new Set([NEW_RAW]));
});

it('[B1-05w#33][BR-PROD-05] Redis 连不上时同样不加锁，详情不因为锁失败', async () => {
  const f = reparseFixture({ redis: unavailableRedis() });

  const card = await f.run();

  expect(card).toMatchObject({ stale: false, final_price_fen: 2990 });
  expect(askedRaws(f.fake)).toEqual([NEW_RAW]);
});

it('[B1-05w#34][BR-PROD-05] 京东按 App 的 product_key.jd.mode 派生比对，不按条目猜模式：item 模式下 skuId 相同的条目不算同键', async () => {
  const f = reparseFixture({
    productKey: 'jd:synthetic_sku',
    jdMode: 'item',
    stored: { platform: 'jd' },
  });
  f.searchItems.mockResolvedValue(
    onePage([
      item({
        platform: 'jd',
        item_id: null,
        itemId: 'renewed_other002_tail',
        skuId: 'synthetic_sku',
      }),
    ]),
  );

  expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

  expect(f.getItem).not.toHaveBeenCalled();
});
