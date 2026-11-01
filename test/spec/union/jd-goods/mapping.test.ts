import { deriveProductKey } from '@couli/domain';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import type { JdProductKeyMode } from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import { instant } from '../jd-core/kit.ts';
import { num } from '../jd-orders/kit.ts';
import {
  both,
  ctx,
  invoke,
  itemRef,
  listing,
  mapped,
  mode,
  otherItemId,
  otherSkuId,
  ports,
  row,
  searched,
  skuId,
  title,
  wholeItemId,
  wire,
  type Row,
} from './kit.ts';

// BR-PROD-03 / 05：商品键模式每次调用读一次，缺省 item。下游（deriveProductKey、catalog、parsing、
// 演示适配器）都按 ItemRef 的 itemId / skuId 取原串，所以 DTO 在 item_id 之外同时给出这两个字段。
type Read = (appId: string) => Promise<JdProductKeyMode>;

function commission(commissionShare: unknown): Row {
  return row({ commissionInfo: { commissionShare } });
}

it('[AC-B1-04zc#36] 一条商品的完整映射，搜索与详情一致', async () => {
  for (const item of await both(row())) {
    expect(item).toMatchObject({
      platform: 'jd',
      item_id: wholeItemId,
      itemId: wholeItemId,
      skuId,
      title,
      price_fen: 3990n,
      coupon_fen: 1000n,
      final_price_fen: 2990n,
      commission_rate_bp: 5000n,
      quoted_at: instant,
      price_status: 'ok',
    });
  }
});

it('[AC-B1-04zc#37] 没配 productKeyMode 时按 item：item_id = itemId 全串', async () => {
  expect((await searched(row())).item_id).toBe(wholeItemId);
});

it('[AC-B1-04zc#38] item 模式取 itemId 全串，sku 模式取 skuId 字符串', async () => {
  expect((await searched(row(), mode('item'))).item_id).toBe(wholeItemId);
  expect((await searched(row(), mode('sku'))).item_id).toBe(skuId);
});

it.each(['12345678', '1234567890123456', '9007199254740993', '12345678901234567890'])(
  '[AC-B1-04zc#39] sku 模式下 skuId %s 按原文取，16 位内外都无损',
  async (text) => {
    const item = await searched(row({ skuId: num(text) }), mode('sku'));
    expect(item).toMatchObject({ item_id: text, skuId: text });
  },
);

it('[AC-B1-04zc#40] 映射结果能派生商品键（BR-PROD-03）：item 模式取 B 段，sku 模式取 skuId', async () => {
  const platform = { platform: 'jd', keyPrefix: 'jd' };
  const item = await searched(row(), mode('item'));
  expect(deriveProductKey({ ...platform, jdMode: 'item' }, item)).toBe('jd:i_Bseg');
  const sku = await searched(row(), mode('sku'));
  expect(deriveProductKey({ ...platform, jdMode: 'sku' }, sku)).toBe(`jd:${skuId}`);
});

it('[AC-B1-04zc#41] item 模式下行里没有 skuId（sceneId=1 的实测形状）：照常出卡', async () => {
  const item = await searched(row({ skuId: undefined }), mode('item'));
  expect(item).toMatchObject({ item_id: wholeItemId, itemId: wholeItemId, price_status: 'ok' });
  expect(item.skuId ?? null).toBeNull();
});

it('[AC-B1-04zc#42] sku 模式下行里没有 skuId：不拿 itemId 顶替', async () => {
  const rows = [row({ skuId: undefined }), row({ itemId: otherItemId, skuId: num(otherSkuId) })];
  const { adapter } = wire(() => listing(rows), mode('sku'));
  const outcome = await adapter.searchItems({ keyword: '合成关键词' }, ctx).then(
    (page) => page.items.map((item) => item.item_id).join(','),
    (error: unknown) => (error instanceof UnionError ? error.code : String(error)),
  );
  expect(['invalid_dto', otherSkuId]).toContain(outcome);
});

it('[AC-B1-04zc#43] item 模式下行里没有 itemId：不拿 skuId 顶替', async () => {
  const rows = [row({ itemId: undefined }), row({ itemId: otherItemId, skuId: num(otherSkuId) })];
  const { adapter } = wire(() => listing(rows), mode('item'));
  const outcome = await adapter.searchItems({ keyword: '合成关键词' }, ctx).then(
    (page) => page.items.map((item) => item.item_id).join(','),
    (error: unknown) => (error instanceof UnionError ? error.code : String(error)),
  );
  expect(['invalid_dto', otherItemId]).toContain(outcome);
});

it.each(ports)('[AC-B1-04zc#44] %s 每次调用按 ctx.appId 读一次商品键模式', async (port) => {
  const read = vi.fn<Read>(async () => 'item');
  const { adapter } = wire(() => listing([row()]), { productKeyMode: { read } });
  await invoke(adapter, port);
  await invoke(adapter, port);
  expect(read.mock.calls).toEqual([[ctx.appId], [ctx.appId]]);
});

it('[AC-B1-04zc#45] 模式不缓存：配置改了，下一次调用就按新模式取', async () => {
  const read = vi.fn<Read>();
  read.mockResolvedValueOnce('item').mockResolvedValueOnce('sku');
  const { adapter } = wire(() => listing([row()]), { productKeyMode: { read } });
  const before = await adapter.searchItems({ keyword: '合成关键词' }, ctx);
  const after = await adapter.searchItems({ keyword: '合成关键词' }, ctx);
  expect(before.items[0]?.item_id).toBe(wholeItemId);
  expect(after.items[0]?.item_id).toBe(skuId);
});

it.each(ports)('[AC-B1-04zc#46] %s 读到其他模式值 → invalid_dto', async (port) => {
  const read = vi.fn<Read>(async () => 'spu' as unknown as JdProductKeyMode);
  const { adapter } = wire(() => listing([row()]), { productKeyMode: { read } });
  await expect(invoke(adapter, port)).rejects.toMatchObject({
    code: 'invalid_dto',
    platform: 'jd',
  });
});

it.each<[string, bigint]>([
  ['50', 5000n],
  ['50.0', 5000n],
  ['100', 10000n],
  ['0', 0n],
  ['12.34', 1234n],
  ['0.29', 29n],
  ['8.2', 820n],
  ['12.345', 1234n],
  ['12.349', 1234n],
  ['99.999', 9999n],
])('[AC-B1-04zc#47] commissionShare %s → %s bp，超两位小数 floor', async (text, bp) => {
  const item = await searched(commission(num(text)));
  expect(item.commission_rate_bp).toBe(bp);
  expect(item.price_status).toBe('ok');
});

const badCommissions: readonly [string, Row][] = [
  ['commissionInfo 缺失', row({ commissionInfo: undefined })],
  ['commissionShare 缺失', row({ commissionInfo: {} })],
  ['commissionShare 为 null', commission(null)],
  ['commissionShare 空串', commission('')],
  ['commissionShare 非数字', commission('abc')],
  ['commissionShare 负数', commission(num('-1'))],
  ['commissionShare 超过 100', commission(num('100.01'))],
  ['commissionShare 科学计数法', commission(num('5e1'))],
];

it.each(badCommissions)(
  '[AC-B1-04zc#48] 搜索遇%s：该商品不出卡，不当 0，同页其他商品照常',
  async (_label, input) => {
    const { adapter } = wire(() => listing([input, row({ itemId: otherItemId })]));
    const page = await adapter.searchItems({ keyword: '合成关键词' }, ctx);
    expect(page.items.map((item) => item.item_id)).toEqual([otherItemId]);
  },
);

it.each(badCommissions)(
  '[AC-B1-04zc#49] 详情遇%s：按数据异常标 price_status=anomaly，不当 0',
  async (_label, input) => {
    const { adapter } = wire(() => listing([input]));
    expect(await adapter.getItem(itemRef, ctx)).toMatchObject({
      item_id: wholeItemId,
      price_status: 'anomaly',
    });
  },
);

it('[AC-B1-04zc#50] 任意比例原文：换算与 bigint 手算一致，超两位小数 floor', () => {
  const share = fc
    .tuple(fc.integer({ min: 0, max: 99 }), fc.stringMatching(/^[0-9]{0,6}$/))
    .map(([whole, tail]) => ({
      text: tail === '' ? `${whole}` : `${whole}.${tail}`,
      bp: BigInt(whole) * 100n + BigInt(tail.slice(0, 2).padEnd(2, '0')),
    }));
  expect(() =>
    fc.assert(
      fc.property(share, ({ text, bp }) => {
        const item = mapped(commission(num(text)));
        return item.commission_rate_bp === bp && item.price_status === 'ok';
      }),
      propParams(),
    ),
  ).not.toThrow();
});

it('[AC-B1-04zc#51] 图片不映射（B1-22s）：报文有图也不进 DTO', async () => {
  for (const item of await both(row())) {
    expect(item.item_id).toBe(wholeItemId);
    expect(item).not.toHaveProperty('main_image_url');
    expect(item).not.toHaveProperty('image_urls');
  }
});

it('[AC-B1-04zc#52] 只读映射到的字段，不 spread 报文', async () => {
  for (const item of await both(row())) {
    expect(item.item_id).toBe(wholeItemId);
    for (const name of ['priceInfo', 'couponInfo', 'commissionInfo', 'imageInfo', 'materialUrl']) {
      expect(item).not.toHaveProperty(name);
    }
  }
});
