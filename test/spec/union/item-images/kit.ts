import { expect } from 'vitest';
import type { ItemImages } from '../../../../apps/api/src/modules/union/domain/item-images.ts';
import type { UnionItem, UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import { keyword, online, refOf, type DemoPort } from '../demo/kit.ts';

// AC-B1-22s-* 是任务内验收标签。口径（与 domain/item-images.ts 说明一致）：
// image_urls 是上游多图原样清洗（不并入主图、也不剔除主图），主图不从多图补；
// 清洗后没有合格值的字段缺省（不给空数组、不给 undefined 值的键）。
export const IMAGE_FIELDS = ['main_image_url', 'image_urls'] as const;
export const MAX_IMAGES = 9;
export const MAX_URL_LENGTH = 2048;
export const DEMO_PREFIX = 'https://demo.invalid/';

/** The two image fields as own properties of a DTO; absent fields stay absent. */
export function imagesOf(value: object): ItemImages {
  const out: { main_image_url?: string; image_urls?: readonly string[] } = {};
  if (Object.hasOwn(value, 'main_image_url')) {
    out.main_image_url = Reflect.get(value, 'main_image_url') as string;
  }
  if (Object.hasOwn(value, 'image_urls')) {
    out.image_urls = Reflect.get(value, 'image_urls') as readonly string[];
  }
  return out;
}

export function imageCount(value: object): number {
  return imagesOf(value).image_urls?.length ?? 0;
}

export function urlsOf(value: object): string[] {
  const images = imagesOf(value);
  return [
    ...(images.main_image_url === undefined ? [] : [images.main_image_url]),
    ...(images.image_urls ?? []),
  ];
}

/** https only, no whitespace (incl. U+3000) and no C0 / DEL / C1 control character. */
export function cleanUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (!value.startsWith('https://') || value.length > MAX_URL_LENGTH) return false;
  if (/\s/u.test(value)) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

/** Every demo catalog item, through the search pages (every demo title contains 演示). */
export async function catalog(port: DemoPort): Promise<UnionItem[]> {
  const items: UnionItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await port.searchItems(
      cursor === undefined ? { keyword } : { keyword, cursor },
      online,
    );
    items.push(...result.items);
    if (result.nextCursor === null) {
      expect(items.length).toBeGreaterThan(0);
      return items;
    }
    cursor = result.nextCursor;
  }
  throw new Error('demo catalog should end within 20 search pages');
}

export interface DetailRow {
  readonly item: UnionItem;
  readonly detail: UnionItemDetail;
}

/** The detail of every demo catalog item, in catalog order. */
export async function details(port: DemoPort): Promise<DetailRow[]> {
  const rows: DetailRow[] = [];
  for (const item of await catalog(port)) {
    rows.push({ item, detail: await port.getItem(refOf(item), online) });
  }
  return rows;
}

/** A detail with exactly MAX_IMAGES images; fails the test when the demo has none. */
export function fullSample(rows: readonly DetailRow[]): DetailRow {
  const found = rows.find((row) => imageCount(row.detail) === MAX_IMAGES);
  expect(found, `demo 目录应有恰 ${String(MAX_IMAGES)} 张图的商品`).toBeDefined();
  return found!;
}
