import { expect, it } from 'vitest';
import type { QuotaLimiter } from '../../../../apps/api/src/modules/platform/index.ts';
import { normalizeItemImages } from '../../../../apps/api/src/modules/union/domain/item-images.ts';
import {
  createGovernedAdapter,
  type RegisteredPlatform,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionItemDetail,
} from '../../../../apps/api/src/modules/union/index.ts';
import { ManualScheduler } from '../../platform/http/kit.ts';
import { demo, online, platforms, refOf } from '../demo/kit.ts';
import { IMAGE_FIELDS, MAX_IMAGES, details, fullSample, imagesOf } from './kit.ts';

function endpoint(platform: RegisteredPlatform): UnionEndpoint {
  return { platform, mode: 'demo', baseUrl: null, quotaKey: `images:${platform}` };
}

function quota(platform: RegisteredPlatform): QuotaLimiter {
  return { bucketKey: `images:${platform}`, tryAcquire: () => true };
}

function govern(adapter: UnionAdapter): UnionAdapter {
  const platform = adapter.platform as RegisteredPlatform;
  return createGovernedAdapter(adapter, {
    endpoint: endpoint(platform),
    scheduler: new ManualScheduler(),
    quota: quota(platform),
  });
}

const base: UnionItemDetail = {
  platform: 'jd',
  itemId: 'synthetic-images-item',
  skuId: null,
  title: '合成图片测试商品（非平台录制）',
  price_fen: 10000n,
  coupon_fen: 1200n,
  final_price_fen: 8800n,
  commission_rate_bp: 1234n,
  quoted_at: '2026-10-06T01:02:03.456Z',
  description: '合成描述',
};

function stub(detail: UnionItemDetail): UnionAdapter {
  return {
    platform: 'jd',
    searchItems: async () => ({ items: [], nextCursor: null }),
    getItem: async () => detail,
    resolveLink: async () => ({ item: { platform: 'jd', itemId: base.itemId ?? null } }),
    convert: async () => ({ kind: 'url', url: 'https://example.invalid/result' }),
    listOrders: async () => ({ items: [], nextCursor: null }),
  };
}

it.each(platforms)(
  '[AC-B1-22s-GOV#1] %s 治理包装后 demo 详情的图片字段原样（内容、顺序、张数、缺省）',
  async (platform) => {
    const raw = demo(platform);
    const port = govern(raw);
    const rows = await details(raw);
    const sample = fullSample(rows);
    const governed = await port.getItem(refOf(sample.item), online);
    expect(imagesOf(governed)).toEqual(imagesOf(sample.detail));
    expect(imagesOf(governed).image_urls).toHaveLength(MAX_IMAGES);
    for (const { item, detail } of rows) {
      const through = await port.getItem(refOf(item), online);
      expect(through).toEqual(detail);
      for (const field of IMAGE_FIELDS) {
        expect(Object.hasOwn(through, field)).toBe(Object.hasOwn(detail, field));
      }
    }
  },
);

it('[AC-B1-22s-GOV#2] 治理包装不增删、不改写适配器给出的图片字段', async () => {
  const images = normalizeItemImages({
    main_image_url: 'https://img.synthetic.invalid/jd/main.jpg',
    image_urls: Array.from(
      { length: MAX_IMAGES },
      (_, index) => `https://img.synthetic.invalid/jd/${String(index + 1)}.jpg`,
    ),
  });
  expect(images.image_urls).toHaveLength(MAX_IMAGES);
  const withImages: UnionItemDetail = { ...base, ...images };
  const through = await govern(stub(withImages)).getItem({ platform: 'jd', itemId: 'x' }, online);
  expect(through).toEqual(withImages);
  expect(imagesOf(through)).toEqual(images);
  const without = await govern(stub(base)).getItem({ platform: 'jd', itemId: 'x' }, online);
  expect(without).toEqual(base);
  for (const field of IMAGE_FIELDS) expect(Object.hasOwn(without, field)).toBe(false);
});
