import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { normalizeItemImages } from '../../../../apps/api/src/modules/union/domain/item-images.ts';
import { demo, firstItem, keys, online, platforms, refOf } from '../demo/kit.ts';
import {
  DEMO_PREFIX,
  IMAGE_FIELDS,
  MAX_IMAGES,
  cleanUrl,
  details,
  fullSample,
  imageCount,
  imagesOf,
  urlsOf,
} from './kit.ts';

const seeds = ['catalog-a', 'catalog-b'] as const;

it.each(platforms)(
  '[AC-B1-22s-DEMO#1] %s 详情图片确定：同一商品重复调用、重建实例、换时钟都相同，不同商品不共用地址',
  async (platform) => {
    const port = demo(platform);
    const rows = await details(port);
    expect(rows.some((row) => urlsOf(row.detail).length > 0)).toBe(true);
    const rebuilt = demo(platform, 'catalog-a', new FixedClock('2044-05-06T07:08:09.010Z'));
    const owner = new Map<string, number>();
    for (const [index, { item, detail }] of rows.entries()) {
      const images = imagesOf(detail);
      expect(imagesOf(await port.getItem(refOf(item), online))).toEqual(images);
      expect(imagesOf(await rebuilt.getItem(refOf(item), online))).toEqual(images);
      for (const value of urlsOf(detail)) {
        const first = owner.get(value);
        expect(first === undefined || first === index, `${value} 被两个商品共用`).toBe(true);
        owner.set(value, index);
      }
    }
    const mains = rows.flatMap(({ detail }) => imagesOf(detail).main_image_url ?? []);
    expect(mains.length).toBeGreaterThan(0);
    expect(new Set(mains).size).toBe(mains.length);
  },
);

it.each(platforms)(
  '[AC-B1-22s-DEMO#2] %s 图片地址只用 https://demo.invalid/，逐条合规且已是清洗后的形态',
  async (platform) => {
    for (const seed of seeds) {
      const rows = await details(demo(platform, seed));
      for (const { detail } of rows) {
        const images = imagesOf(detail);
        for (const value of urlsOf(detail)) {
          expect(value.startsWith(DEMO_PREFIX), value).toBe(true);
          expect(cleanUrl(value), value).toBe(true);
        }
        if (images.image_urls !== undefined) {
          expect(images.image_urls.length).toBeGreaterThan(0);
          expect(images.image_urls.length).toBeLessThanOrEqual(MAX_IMAGES);
          expect(new Set(images.image_urls).size).toBe(images.image_urls.length);
        }
        expect(normalizeItemImages(images)).toEqual(images);
      }
    }
  },
);

it.each(platforms)(
  '[AC-B1-22s-DEMO#3] %s 张数按商品确定：目录里有 0 张、1 张、恰 9 张的样本，第一个搜索结果是 0 张',
  async (platform) => {
    for (const seed of seeds) {
      const port = demo(platform, seed);
      const rows = await details(port);
      const counts = rows.map(({ detail }) => imageCount(detail));
      expect(counts).toContain(0);
      expect(counts).toContain(1);
      expect(counts).toContain(MAX_IMAGES);
      expect(Math.max(...counts)).toBe(MAX_IMAGES);
      fullSample(rows);
      // 0 张样本两个字段都缺省；第一个搜索结果就是它（B1-04o DATA#5 只允许详情多出 description）。
      const item = await firstItem(port);
      const detail = await port.getItem(refOf(item), online);
      for (const field of IMAGE_FIELDS) expect(Object.hasOwn(detail, field)).toBe(false);
      expect(keys(detail).filter((key) => key !== 'description')).toEqual(keys(item));
      expect(await demo(platform, seed).getItem(refOf(item), online)).toEqual(detail);
    }
  },
);

it.each(platforms)(
  '[AC-B1-22s-DEMO#4] %s 搜索、物料流、频道榜单不带图片字段；价格场景不改详情图片',
  async (platform) => {
    const port = demo(platform);
    const rows = await details(port);
    const sample = fullSample(rows);
    const images = imagesOf(sample.detail);
    for (const scenario of ['coupon_expired', 'no_commission']) {
      const changed = await port.getItem(refOf(sample.item), { ...online, scenario });
      expect(imagesOf(changed)).toEqual(images);
    }
    expect(port.channelRanking).toBeTypeOf('function');
    const ranking = await port.channelRanking!(
      { channelId: 'demo-images-channel', categoryId: null, pageNo: 1, pageSize: 50 },
      online,
    );
    const listed = [
      ...rows.map(({ item }) => item),
      ...(await port.materialFeed({}, online)).items,
      ...ranking.items.map((entry) => entry.item),
    ];
    expect(listed.length).toBeGreaterThan(rows.length);
    for (const item of listed) {
      for (const field of IMAGE_FIELDS) expect(Object.hasOwn(item, field)).toBe(false);
    }
  },
);
