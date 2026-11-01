// B1-05y: 重新解析步骤 1 on a platform whose resolveLink is not implemented falls back to 步骤 2,
// once, and does not count as a failure; every other error of step ① keeps its 结果分类 and does not
// fall back. Through getProduct and the shared reparser, as the detail and the pool reach it.
import { expect, it } from 'vitest';
import {
  createRawReparser,
  type RawReparseTarget,
} from '../../../../apps/api/src/modules/catalog/application/raw-reparse.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  CANONICAL_URL,
  NEW_RAW,
  STORED_TITLE,
  askedRaws,
  onePage,
  outages,
  unionFake,
  type ReparseFixture,
} from '../detail-reparse/kit.ts';
import { APP_ID, NOW, PRODUCT_KEY, item } from '../detail/kit.ts';
import { rejection } from '../hot-rank/kit.ts';
import { linkedFixture, unimplemented, unimplementedLinkFixture } from './kit.ts';

const ONLINE = { appId: APP_ID, purpose: 'online' };

/** Step ① was asked once, with the row's link: it is not tried again. */
function expectOneLinkCall(f: ReparseFixture): void {
  expect(f.resolveLink.mock.calls.map(([url]) => url)).toEqual([CANONICAL_URL]);
}

/** Step ② was asked once, by title, on the same purpose. */
function expectOneTitleSearch(f: ReparseFixture): void {
  expect(f.searchItems).toHaveBeenCalledTimes(1);
  expect(f.searchItems.mock.calls[0]?.[0]).toMatchObject({ keyword: STORED_TITLE });
  expect(f.searchItems.mock.calls[0]?.[1]).toMatchObject(ONLINE);
}

function expectNothingFound(f: ReparseFixture): void {
  expect(f.getItem).not.toHaveBeenCalled();
  expect(f.registerProductRef).not.toHaveBeenCalled();
  expect(f.rows).toEqual([]);
  expect(f.register).not.toHaveBeenCalled();
  expect(f.quote).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------------------------
// resolveLink is not implemented and the title search finds the target.

it('[B1-05y#1][BR-PROD-05] resolveLink 未实现、标题搜到目标 → found：第①步只问一次，回落第②步，用新原串出卡，product_refs 和链接记新原串', async () => {
  const f = unimplementedLinkFixture();

  const card = await f.run();

  expect(card).toMatchObject({
    product_key: PRODUCT_KEY,
    final_price_fen: 2990,
    stale: false,
    availability: 'ok',
  });
  expectOneLinkCall(f);
  expectOneTitleSearch(f);
  expect(askedRaws(f.fake)).toEqual([NEW_RAW]);
  expect(f.registerProductRef).toHaveBeenCalledWith(
    expect.objectContaining({
      appId: APP_ID,
      productKey: PRODUCT_KEY,
      rawItemId: NEW_RAW,
      source: 'detail',
    }),
    expect.anything(),
  );
  expect(f.rows[0]?.ref.rawItemId).toBe(NEW_RAW);
});

it('[B1-05y#2][BR-PROD-05] 未实现不算一次失败：有合格池行时回落搜到目标，出联盟新价，不走池价', async () => {
  const f = unimplementedLinkFixture({ pooled: true });

  const card = await f.run();

  expect(card).toMatchObject({ stale: false, final_price_fen: 2990 });
  expect(askedRaws(f.fake)).toEqual([NEW_RAW]);
});

it('[B1-05y#3][BR-PROD-05] 未实现不算一次失败：有旧缓存时回落搜到目标，不答旧缓存，stale=false', async () => {
  const f = unimplementedLinkFixture({ cached: true });
  await f.warmCache();

  const card = await f.run();

  expect(card).toMatchObject({ stale: false, final_price_fen: 2990 });
  expectOneLinkCall(f);
  expect(askedRaws(f.fake)).toEqual([NEW_RAW]);
});

it('[B1-05y#4][BR-PROD-05] 回落不分平台：拼多多 resolveLink 未实现，按平台字段取新原串，product_key 不变', async () => {
  const productKey = 'pdd:synthetic001';
  const hit = item({
    platform: 'pdd',
    item_id: null,
    goods_id: 'synthetic001',
    goods_sign: 'synthetic-renewed-sign',
  });
  const f = unimplementedLinkFixture({ productKey, stored: { platform: 'pdd' } });
  f.searchItems.mockResolvedValue(onePage([hit]));
  f.getItem.mockResolvedValue(hit);

  const card = await f.run();

  expect(card).toMatchObject({ product_key: productKey, stale: false });
  expectOneLinkCall(f);
  expect(f.getItem.mock.calls.map(([asked]) => asked)).toEqual([
    { platform: 'pdd', goods_sign: 'synthetic-renewed-sign' },
  ]);
});

// ---------------------------------------------------------------------------------------------
// The reparser as the pool reaches it: its own quota purpose, its own source.

function poolReparse() {
  const fake = unionFake();
  fake.resolveLink.mockRejectedValue(unimplemented());
  const reparser = createRawReparser({
    union: fake.union,
    clock: new FixedClock(NOW),
    redis: null,
    purpose: 'pool_refresh',
  });
  const target: RawReparseTarget = {
    appId: APP_ID,
    platform: 'taobao',
    productKey: PRODUCT_KEY,
    jdMode: 'item',
    canonicalUrl: CANONICAL_URL,
    title: STORED_TITLE,
    source: 'pool',
    isTarget: (candidate) => candidate.platform === 'taobao' && candidate.item_id === NEW_RAW,
  };
  return { fake, run: () => reparser.reparse(target) };
}

it('[B1-05y#5][BR-PROD-05] 商品池的重解析同样回落：标题搜索沿用调用方的配额用途，结果 found，来源 pool', async () => {
  const { fake, run } = poolReparse();

  const result = await run();

  expect(result).toMatchObject({
    kind: 'found',
    ref: { rawItemId: NEW_RAW, title: STORED_TITLE, source: 'pool' },
  });
  expect(fake.resolveLink).toHaveBeenCalledTimes(1);
  expect(fake.searchItems).toHaveBeenCalledTimes(1);
  expect(fake.searchItems.mock.calls[0]?.[1]).toMatchObject({
    appId: APP_ID,
    purpose: 'pool_refresh',
  });
});

it('[B1-05y#6][BR-PROD-05] 商品池的重解析：resolveLink 未实现、标题搜不到 → ref_expired，不抛错', async () => {
  const { fake, run } = poolReparse();
  fake.searchItems.mockResolvedValue(onePage([]));

  expect(await run()).toEqual({ kind: 'ref_expired' });
});

// ---------------------------------------------------------------------------------------------
// resolveLink is not implemented and the title search does not find the target: 结果分类 ②.

it.each([
  { label: '第一页没有结果', items: [] },
  { label: '第一页只有别的键', items: [item({ item_id: 'synthetic-other002' })] },
])(
  '[B1-05y#7][BR-PROD-05] resolveLink 未实现、标题搜不到（$label）→ 30143 引用失效，不是 50001，第①步不重试',
  async ({ items }) => {
    const f = unimplementedLinkFixture();
    f.searchItems.mockResolvedValue(onePage(items));

    expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

    expectOneLinkCall(f);
    expectOneTitleSearch(f);
    expectNothingFound(f);
  },
);

it('[B1-05y#8][BR-PROD-05] resolveLink 未实现、标题搜不到：有合格池行也是 30143，引用失效不用池价', async () => {
  const f = unimplementedLinkFixture({ pooled: true });
  f.searchItems.mockResolvedValue(onePage([]));

  expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

  expectNothingFound(f);
});

it('[B1-05y#9][BR-PROD-05] resolveLink 未实现、标题搜不到：不删详情缓存', async () => {
  const f = unimplementedLinkFixture({ cached: true });
  await f.warmCache();
  const entries = [...f.memory.rows.entries()];
  expect(entries).toHaveLength(1);
  f.clock.advanceMs(300_000);
  f.searchItems.mockResolvedValue(onePage([]));

  expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

  expect([...f.memory.rows.entries()]).toEqual(entries);
});

it('[B1-05y#10][BR-PROD-05] resolveLink 与 searchItems 都未实现 → 30143 引用失效，不是 50001，也不是暂时失败', async () => {
  const f = unimplementedLinkFixture({ pooled: true });
  f.searchItems.mockRejectedValue(unimplemented());

  expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

  expectOneLinkCall(f);
  expectOneTitleSearch(f);
  expectNothingFound(f);
});

// ---------------------------------------------------------------------------------------------
// The fallback is step ②: what it answers is sorted as step ②'s answers are.

it.each(outages())(
  '[B1-05y#11][BR-PROD-05] 结果分类③：resolveLink 未实现、回落的标题搜索 $label → 50401，不写 product_refs',
  async ({ error }) => {
    const f = unimplementedLinkFixture();
    f.searchItems.mockRejectedValue(error);

    expect(await rejection(() => f.run())).toMatchObject({ code: 50401 });

    expectOneLinkCall(f);
    expectOneTitleSearch(f);
    expectNothingFound(f);
  },
);

// ---------------------------------------------------------------------------------------------
// Any other error of step ① keeps its class and does not fall back.

it.each([
  {
    label: 'upstream_unavailable → 暂时失败 50401',
    error: new UnionError('upstream_unavailable', 'synthetic outage', 'taobao'),
    code: 50401,
  },
  {
    label: 'item_unavailable → 下架 30141',
    error: new UnionError('item_unavailable', 'synthetic off shelf', 'taobao'),
    code: 30141,
  },
  {
    label: 'link_unrecognized → 引用失效 30143',
    error: new UnionError('link_unrecognized', 'synthetic unknown link', 'taobao'),
    code: 30143,
  },
])(
  '[B1-05y#12][BR-PROD-05] resolveLink 的其他错误照旧归类、不回落：$label',
  async ({ error, code }) => {
    const f = linkedFixture();
    f.resolveLink.mockRejectedValue(error);

    expect(await rejection(() => f.run())).toMatchObject({ code });

    expectOneLinkCall(f);
    expect(f.searchItems).not.toHaveBeenCalled();
    expectNothingFound(f);
  },
);

it.each([
  { label: '没有归类的联盟错误', error: new UnionError('invalid_endpoint', 'synthetic', 'taobao') },
  { label: '不是联盟错误', error: new Error('synthetic bug') },
])(
  '[B1-05y#13][BR-PROD-05] 回落只认 adapter_unimplemented：$label 原样抛出，不搜标题',
  async ({ error }) => {
    const f = linkedFixture();
    f.resolveLink.mockRejectedValue(error);

    expect(await rejection(() => f.run())).toBe(error);

    expect(f.searchItems).not.toHaveBeenCalled();
    expectNothingFound(f);
  },
);
