import { deriveProductKey, validateProductKey } from '@couli/domain';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  RegisteredPlatform,
  UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  demo,
  expectItem,
  firstItem,
  instant,
  keys,
  keyword,
  online,
  platforms,
  refOf,
} from './kit.ts';

const prefixes = { taobao: 'tb', jd: 'jd', pdd: 'pdd' } as const;
function productKey(item: UnionItem, platform: RegisteredPlatform): string {
  return deriveProductKey({ platform, keyPrefix: prefixes[platform] }, item);
}

it.each(platforms)(
  '[AC-B1-04o-DATA#1] %s 搜索和物料流只输出显式演示的统一 DTO',
  async (platform) => {
    const port = demo(platform);
    expect(port.platform).toBe(platform);
    for (const page of [
      await port.searchItems({ keyword }, online),
      await port.materialFeed({}, online),
    ]) {
      expect(keys(page)).toEqual(['items', 'nextCursor']);
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.nextCursor === null || typeof page.nextCursor === 'string').toBe(true);
      for (const item of page.items) expectItem(item, platform);
    }
  },
);

it.each(platforms)(
  '[AC-B1-04o-DATA#2] %s 相同种子重建、重试与交错调用结果一致，不同种子改变商品',
  async (platform) => {
    const port = demo(platform);
    const before = await port.searchItems({ keyword }, online);
    const feed = await port.materialFeed({}, online);
    await port.getItem(refOf(before.items[0]!), online);
    expect(
      await port.searchItems({ keyword }, { ...online, requestId: 'another-request' }),
    ).toEqual(before);
    expect(await demo(platform).searchItems({ keyword }, online)).toEqual(before);
    expect(await demo(platform).materialFeed({}, online)).toEqual(feed);
    const other = await demo(platform, 'catalog-b').searchItems({ keyword }, online);
    expect(other.items).not.toEqual(before.items);
  },
);

it.each(platforms)(
  '[AC-B1-04o-DATA#3] %s 游标遍历可重复、无重复商品且能结束，ID 可直接派生 product_key',
  async (platform) => {
    const port = demo(platform);
    const items: UnionItem[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const query = cursor === undefined ? { keyword } : { keyword, cursor };
      const page = await port.searchItems(query, online);
      expect(await demo(platform).searchItems(query, online)).toEqual(page);
      items.push(...page.items);
      if (page.nextCursor === null) {
        cursor = undefined;
        break;
      }
      expect(page.nextCursor).not.toBe('');
      expect(cursors.has(page.nextCursor)).toBe(false);
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    expect(cursor, '演示目录应在 20 页内结束').toBeUndefined();
    expect(items.length).toBeGreaterThan(0);
    const derived = items.map((item) => productKey(item, platform));
    expect(new Set(derived).size).toBe(items.length);
    for (const [index, item] of items.entries()) {
      expectItem(item, platform);
      expect(() =>
        validateProductKey(
          derived[index],
          [{ platform, keyPrefix: prefixes[platform], parseEnabled: true, searchEnabled: true }],
          platform,
        ),
      ).not.toThrow();
      if (platform === 'taobao') {
        expect(derived[index]).toBe(`tb:${item.item_id?.split('-').at(-1)}`);
      } else if (platform === 'jd') {
        expect(item.itemId).toMatch(/^[^_]+_[^_]+/);
        expect(derived[index]).toBe(`jd:i_${item.itemId?.split('_')[1]}`);
        expect(deriveProductKey({ platform, keyPrefix: 'jd', jdMode: 'sku' }, item)).toBe(
          `jd:${item.skuId}`,
        );
      } else {
        expect(item.goods_id).toBeTypeOf('string');
        expect(item.goods_sign).toBeTypeOf('string');
        expect(item.goods_sign).not.toBe(item.goods_id);
        expect(derived[index]).toBe(`pdd:${item.goods_id}`);
      }
    }
    if (platform === 'taobao') {
      expect(items.some((item) => item.item_id?.includes('-'))).toBe(true);
      expect(
        items.some((item) => typeof item.item_id === 'string' && !item.item_id.includes('-')),
      ).toBe(true);
    }
  },
);

it.each(platforms)('[AC-B1-04o-DATA#4] %s 搜索支持从返回的完整标题找到商品', async (platform) => {
  const port = demo(platform);
  const item = await firstItem(port);
  const matches = await port.searchItems({ keyword: item.title }, online);
  expect(matches.items.map((value) => productKey(value, platform))).toContain(
    productKey(item, platform),
  );
  expect(matches.items.every((value) => value.title.includes(item.title))).toBe(true);
  expect(
    (await port.searchItems({ keyword: 'definitely-absent-demo-title-8c27' }, online)).items,
  ).toEqual([]);
});

it.each(platforms)(
  '[AC-B1-04o-DATA#5] %s 详情保留搜索字段，报价时间随注入时钟变化',
  async (platform) => {
    const clock = new FixedClock(instant);
    const port = demo(platform, 'catalog-a', clock);
    const item = await firstItem(port);
    const detail = await port.getItem(refOf(item), online);
    expect(detail).toMatchObject(item);
    expect(keys(detail).filter((key) => key !== 'description')).toEqual(keys(item));
    clock.set('2042-09-10T11:12:13.014Z');
    const later = await port.getItem(refOf(item), online);
    expect(later).toEqual({ ...detail, quoted_at: '2042-09-10T11:12:13.014Z' });
    for (const page of [
      await port.searchItems({ keyword }, online),
      await port.materialFeed({}, online),
    ]) {
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((value) => value.quoted_at === '2042-09-10T11:12:13.014Z')).toBe(
        true,
      );
    }
  },
);
