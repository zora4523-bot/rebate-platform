// B1-15z rule tests: images of POST /v1/shares through the real api entry (BR-ATTR-10 细则
// 「分享页与分享赚入口页」素材图, D10-426; contract ShareMaterials.images): a JD or Pinduoduo share
// answers the composed images of the union detail it read (the demo adapter's, B1-22s), in the
// contract's shape; poster_url stays null; the addresses stay out of the rows the share writes,
// and the server never requests them (不下载转存).
// A search page of the demo holds products with no image, a main image only, a gallery only, a
// gallery repeating the main image and more than 9 images, so one page walks them all.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { sharesHarness, textOf } from '../shares/kit.ts';
import { shareCard, shareable, sharedWithImages } from './kit.ts';
import { MAX_IMAGES, expectedImages, rawUrls } from './oracle.ts';

const h = sharesHarness({ createTestDatabase, acquireTestRedis });

/** The address of a fetch call in URL form, however the caller passed it. */
function addressOf(input: Parameters<typeof fetch>[0]): string {
  return new URL(input instanceof Request ? input.url : String(input)).href;
}

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-15z#2] %s：一页商品逐个分享，images 为 [{url}]，与该次 getItem 的组图一致：主图在首位、去重、至多 9 张、地址原样，无图商品为 []；poster_url 仍 null',
  async (platform) => {
    const t = await h.tenant();
    const sharer = await t.user();
    const counts: number[] = [];
    let withMain = 0;
    for (const card of shareable(await sharer.search(platform))) {
      const { data, detail } = await shareCard(h, sharer, card);
      expect(data.images).toEqual(expectedImages(detail));
      expect(data.images.length).toBeLessThanOrEqual(MAX_IMAGES);
      if (detail.main_image_url !== undefined) {
        withMain += 1;
        expect(data.images[0]).toEqual({ url: detail.main_image_url });
      }
      expect(data.poster_url).toBeNull();
      counts.push(rawUrls(detail).length);
    }
    // The page was not all empty, and it did reach the cap.
    expect(withMain).toBeGreaterThan(0);
    expect(Math.max(...counts)).toBeGreaterThan(MAX_IMAGES);
  },
  120_000,
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-15z#2] %s：图片地址只在响应里：links、share_materials、link_logs 的整行都不含联盟返回的图片地址',
  async (platform) => {
    const t = await h.tenant();
    const sharer = await t.user();
    const { data, detail } = await sharedWithImages(h, sharer, platform);
    const persisted = await h.persisted(t.appId);
    expect(persisted.links.map((row) => row.link_id)).toContain(data.link_id);
    expect(persisted.materials.map((row) => row.link_id)).toContain(data.link_id);
    const logs = await h
      .db()
      .selectFrom('link_logs')
      .selectAll()
      .where('app_id', '=', t.appId)
      .execute();
    // D10-439: idempotency_keys is left out: its retained response is not a business table.
    const stored = textOf({ ...persisted, logs });
    for (const url of rawUrls(detail)) expect(stored).not.toContain(url);
  },
  120_000,
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-15z#2] %s：服务端不抓取图片：分享期间没有任何 fetch 指向联盟返回的图片地址（不下载转存）',
  async (platform) => {
    const t = await h.tenant();
    const sharer = await t.user();
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected network'));
    try {
      const { detail } = await sharedWithImages(h, sharer, platform);
      const requested = network.mock.calls.map(([input]) => addressOf(input));
      const urls = rawUrls(detail).map(addressOf);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(requested).not.toContain(url);
    } finally {
      network.mockRestore();
    }
  },
  120_000,
);
