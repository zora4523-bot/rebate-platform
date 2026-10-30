// B1-28j: one channel page through union's ranking port (adapter channelRanking). The request is
// forwarded as is, positions keep the channel's order (热销榜页的名次按所选频道接口返回的顺序，本系统
// 不重排; BR-TEXT-17 细则「联盟物料频道」), salesText and hasMore pass through, and each position gets
// the product ref search-wiring's toCandidates derives (BR-PROD-03 deriveProductKey, BR-PROD-05
// raw_item_id). Positions without a key or of another platform are dropped, the rest keep their
// relative order. Rank numbering is the use case's (D10-422) and not tested here.
import { deriveProductKey, ProductKeyUnderivable } from '@couli/domain';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { ProductRef } from '../../../../apps/api/src/modules/catalog/domain/types.ts';
import type {
  ChannelRankingEntry,
  RegisteredPlatform,
  UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP,
  JD_CHANNEL,
  JD_MODE_KEY,
  PDD_CHANNEL,
  QUOTED_AT,
  TB_CHANNEL,
  fixture,
  jdItem,
  pageRequest,
  pddItem,
  platformRow,
  position,
  tbItem,
} from './kit.ts';

function refOf(
  item: UnionItem,
  receivedAt: string,
  productKey: string,
  rawItemId: string,
): ProductRef {
  return {
    appId: APP,
    platform: item.platform,
    productKey,
    rawItemId,
    rawFetchedAt: item.quoted_at,
    receivedAt,
    canonicalUrl: null,
    title: item.title,
    shopId: null,
    shopType: null,
    source: 'search',
  };
}

it('[AC-B1-28j#5] page 只调 channelRanking：channelId、categoryId（含 null）、pageNo、pageSize 与请求一致，不调 channelCategories', async () => {
  const f = fixture();
  const upstream = f.upstream();
  const requests = [
    pageRequest(),
    pageRequest({ categoryId: 'synthetic-cat-a', pageNo: 3 }),
    pageRequest({ categoryId: null, pageNo: 2, pageSize: 7 }),
  ];

  for (const request of requests) await upstream.page(request);

  expect(f.fake('taobao').rankingCalls.map((call) => call.req)).toEqual(
    requests.map((request) => ({
      channelId: request.channelId,
      categoryId: request.categoryId,
      pageNo: request.pageNo,
      pageSize: request.pageSize,
    })),
  );
  expect(f.fake('taobao').categoryCalls).toHaveLength(0);
  for (const call of f.fake('taobao').rankingCalls) {
    expect(call.ctx).toMatchObject({ appId: APP, purpose: 'online' });
    expect(typeof call.ctx.requestId).toBe('string');
    expect(call.ctx.requestId).not.toBe('');
  }
});

it('[AC-B1-28j#6][BR-TEXT-17] 条目顺序与频道一致（不按佣金、价格重排，不去掉无销量项），salesText 原样（含 null、空串、带空白），hasMore 原样', async () => {
  const f = fixture();
  const upstream = f.upstream();
  const items: ChannelRankingEntry[] = [
    position(tbItem('low-commission', 1, { commissionBp: 10n, finalFen: 99_900n }), '10万+'),
    position(tbItem('no-sales', 2, { commissionBp: 9_000n, finalFen: 100n }), null),
    position(tbItem('high-commission', 3, { commissionBp: 9_999n }), '  月销 300 件 '),
    position(tbItem('empty-sales', 4, { commissionBp: 0n, finalFen: 1n }), ''),
    position(tbItem('zero-commission', 5, { commissionBp: 0n, finalFen: 50_000n }), '1.2万+'),
  ];
  f.fake('taobao').setPage({ items, hasMore: true });

  const first = await upstream.page(pageRequest());

  expect(first.items.map((entry) => entry.item)).toEqual(items.map((entry) => entry.item));
  expect(first.items.map((entry) => entry.salesText)).toEqual([
    '10万+',
    null,
    '  月销 300 件 ',
    '',
    '1.2万+',
  ]);
  expect(first.hasMore).toBe(true);

  f.fake('taobao').setPage({ items: items.slice(3), hasMore: false });
  const last = await upstream.page(pageRequest({ pageNo: 2 }));

  expect(last.items.map((entry) => entry.item.title)).toEqual([
    'synthetic-empty-sales',
    'synthetic-zero-commission',
  ]);
  expect(last.hasMore).toBe(false);
});

it('[AC-B1-28j#7] 淘宝条目的 ref：productKey 按 key_prefix 与 item_id 末段推导，rawItemId 为 item_id，rawFetchedAt 为 quoted_at，receivedAt 为取数时的时钟，source=search，其余为 null', async () => {
  const f = fixture();
  const upstream = f.upstream();
  const item = tbItem('ref', 101, { quotedAt: QUOTED_AT });
  f.fake('taobao').setPage({ items: [position(item, '99+')], hasMore: false });
  f.clock.advanceMs(5_000);
  const receivedAt = f.clock.now().toISOString();

  const page = await upstream.page(pageRequest());

  expect(page.items).toEqual([
    {
      item,
      salesText: '99+',
      ref: refOf(item, receivedAt, 'tb:101', 'synthetic-ref-101'),
    },
  ]);
});

it('[AC-B1-28j#8] key_prefix 取自 catalog.listPlatforms（不写死）；该平台没有可用 key_prefix 时条目推导不出、全部丢掉，hasMore 原样', async () => {
  const f = fixture();
  const upstream = f.upstream();
  f.fake('taobao').setPage({
    items: [position(tbItem('a', 11), '1'), position(tbItem('b', 12), '2')],
    hasMore: true,
  });

  f.setRows([platformRow('taobao', 'tbx'), platformRow('jd', 'jd'), platformRow('pdd', 'pdd')]);
  const custom = await upstream.page(pageRequest());
  expect(custom.items.map((entry) => entry.ref.productKey)).toEqual(['tbx:11', 'tbx:12']);

  f.setRows([platformRow('jd', 'jd'), platformRow('pdd', 'pdd')]);
  const missing = await upstream.page(pageRequest());
  expect(missing.items).toEqual([]);
  expect(missing.hasMore).toBe(true);

  f.setRows([platformRow('taobao', null), platformRow('jd', 'jd'), platformRow('pdd', 'pdd')]);
  const nullPrefix = await upstream.page(pageRequest());
  expect(nullPrefix.items).toEqual([]);
  expect(nullPrefix.hasMore).toBe(true);
});

it('[AC-B1-28j#9] 京东条目按 product_key.jd.mode：未配置即 item（jd:i_<n>，rawItemId=itemId）；sku 时为 jd:<skuId>、rawItemId=skuId，缺 skuId 的丢掉', async () => {
  const f = fixture();
  const upstream = f.upstream();
  const a = jdItem('a', 21);
  const b = jdItem('b', 22);
  const noSku: UnionItem = { ...jdItem('no-sku', 23), skuId: null };
  f.fake('jd').setPage({
    items: [position(a, '1'), position(noSku, '2'), position(b, '3')],
    hasMore: false,
  });
  const request = pageRequest({ platform: 'jd', channelId: JD_CHANNEL });

  const itemMode = await upstream.page(request);
  expect(
    itemMode.items.map((entry) => [entry.ref.productKey, entry.ref.rawItemId, entry.salesText]),
  ).toEqual([
    ['jd:i_21', 'synthetic_21', '1'],
    ['jd:i_23', 'synthetic_23', '2'],
    ['jd:i_22', 'synthetic_22', '3'],
  ]);

  f.settings.set(JD_MODE_KEY, 'sku');
  const skuMode = await upstream.page(request);
  expect(
    skuMode.items.map((entry) => [entry.ref.productKey, entry.ref.rawItemId, entry.salesText]),
  ).toEqual([
    ['jd:sku21', 'sku21', '1'],
    ['jd:sku22', 'sku22', '3'],
  ]);
  expect(skuMode.items.map((entry) => entry.ref.platform)).toEqual(['jd', 'jd']);
});

it('[AC-B1-28j#10] 拼多多条目：productKey 为 pdd:<goods_id>，rawItemId 优先 goods_sign、没有时用 goods_id', async () => {
  const f = fixture();
  const upstream = f.upstream();
  const signed = pddItem('signed', 31);
  const unsigned = pddItem('unsigned', 32, null);
  f.fake('pdd').setPage({
    items: [position(signed, null), position(unsigned, '5')],
    hasMore: true,
  });
  const receivedAt = f.clock.now().toISOString();

  const page = await upstream.page(pageRequest({ platform: 'pdd', channelId: PDD_CHANNEL }));

  expect(page).toEqual({
    items: [
      { item: signed, salesText: null, ref: refOf(signed, receivedAt, 'pdd:g31', 'sign-31') },
      { item: unsigned, salesText: '5', ref: refOf(unsigned, receivedAt, 'pdd:g32', 'g32') },
    ],
    hasMore: true,
  });
});

it('[AC-B1-28j#11] 推导不出 product_key 或平台不符的条目丢掉，其余保持相对顺序与各自的 salesText', async () => {
  const f = fixture();
  const upstream = f.upstream();
  const blankId: UnionItem = { ...tbItem('blank-id', 0), item_id: '' };
  const trailingDash: UnionItem = { ...tbItem('trailing-dash', 0), item_id: 'synthetic-x-' };
  const noId: UnionItem = { ...tbItem('no-id', 0), item_id: null };
  f.fake('taobao').setPage({
    items: [
      position(tbItem('first', 41), 'A'),
      position(jdItem('foreign-jd', 42), 'X'),
      position(blankId, 'X'),
      position(tbItem('second', 43), null),
      position(pddItem('foreign-pdd', 44), 'X'),
      position(trailingDash, 'X'),
      position(noId, 'X'),
      position(tbItem('third', 45), 'C'),
    ],
    hasMore: true,
  });

  const page = await upstream.page(pageRequest());

  const kept = page.items.map((entry) => [entry.item.title, entry.salesText, entry.ref.productKey]);
  expect(kept).toEqual([
    ['synthetic-first', 'A', 'tb:41'],
    ['synthetic-second', null, 'tb:43'],
    ['synthetic-third', 'C', 'tb:45'],
  ]);
  expect(page.items.every((entry) => entry.ref.platform === 'taobao')).toBe(true);
  expect(page.hasMore).toBe(true);
});

const PLATFORM_CHANNELS: Readonly<Record<RegisteredPlatform, string>> = {
  taobao: TB_CHANNEL,
  jd: JD_CHANNEL,
  pdd: PDD_CHANNEL,
};
const PREFIXES: Readonly<Record<RegisteredPlatform, string>> = {
  taobao: 'tb',
  jd: 'jd',
  pdd: 'pdd',
};

function rawIdOf(item: UnionItem, jdMode: 'item' | 'sku'): string | undefined {
  const filled = (value: string | null | undefined) =>
    typeof value === 'string' && value !== '' ? value : undefined;
  if (item.platform === 'taobao') return filled(item.item_id);
  if (item.platform === 'jd') return jdMode === 'sku' ? filled(item.skuId) : filled(item.itemId);
  if (item.platform === 'pdd') return filled(item.goods_sign) ?? filled(item.goods_id);
  return undefined;
}

/** The ref search-wiring's toCandidates gives the item, or undefined when it drops it. */
function expectedRef(
  platform: RegisteredPlatform,
  item: UnionItem,
  jdMode: 'item' | 'sku',
  receivedAt: string,
): ProductRef | undefined {
  if (item.platform !== platform) return undefined;
  let productKey: string;
  try {
    productKey = deriveProductKey(
      { platform, keyPrefix: PREFIXES[platform], ...(platform === 'jd' ? { jdMode } : {}) },
      item,
    );
  } catch (error: unknown) {
    if (error instanceof ProductKeyUnderivable) return undefined;
    throw error;
  }
  const rawItemId = rawIdOf(item, jdMode);
  return rawItemId === undefined ? undefined : refOf(item, receivedAt, productKey, rawItemId);
}

const idArb = fc.option(fc.stringMatching(/^[a-z0-9_-]{0,6}$/), { nil: null });
const itemArb = fc.record({
  platform: fc.constantFrom<RegisteredPlatform>('taobao', 'jd', 'pdd'),
  a: idArb,
  b: idArb,
  commissionBp: fc.bigInt({ min: 0n, max: 10_000n }),
  salesText: fc.option(fc.string({ maxLength: 8 }), { nil: null }),
});

it('[AC-B1-28j#12] 属性：任意平台、京东口径与条目组合，page 的结果恰为频道条目中可推导且平台相符者，顺序、商品、salesText、ref 逐项对应，hasMore 原样', async () => {
  const f = fixture();
  const upstream = f.upstream();
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom<RegisteredPlatform>('taobao', 'jd', 'pdd'),
      fc.constantFrom<'item' | 'sku'>('item', 'sku'),
      fc.array(itemArb, { maxLength: 20 }),
      fc.boolean(),
      async (platform, jdMode, specs, hasMore) => {
        f.settings.set(JD_MODE_KEY, jdMode);
        const entries: ChannelRankingEntry[] = specs.map((spec, index) => {
          const title = `synthetic-p-${String(index)}`;
          const base = {
            title,
            price_fen: 1000n,
            coupon_fen: 0n,
            final_price_fen: 1000n,
            commission_rate_bp: spec.commissionBp,
            quoted_at: QUOTED_AT,
          };
          const item: UnionItem =
            spec.platform === 'taobao'
              ? { ...base, platform: 'taobao', item_id: spec.a }
              : spec.platform === 'jd'
                ? { ...base, platform: 'jd', itemId: spec.a, skuId: spec.b }
                : { ...base, platform: 'pdd', goods_id: spec.a, goods_sign: spec.b };
          return position(item, spec.salesText);
        });
        f.fake(platform).setPage({ items: entries, hasMore });
        const receivedAt = f.clock.now().toISOString();

        const page = await upstream.page(
          pageRequest({ platform, channelId: PLATFORM_CHANNELS[platform] }),
        );

        const expected = entries.flatMap((entry) => {
          const ref = expectedRef(platform, entry.item, jdMode, receivedAt);
          return ref === undefined ? [] : [{ item: entry.item, salesText: entry.salesText, ref }];
        });
        expect(page.items).toEqual(expected);
        expect(page.hasMore).toBe(hasMore);
        checked += 1;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);
