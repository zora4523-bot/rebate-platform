import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture, fixture, service, success, type Body } from './kit.ts';

const database = databaseFixture(createTestDatabase);
const urls = {
  jd: 'https://jd.example.test/product/12345',
  pdd: 'https://pdd.example.test/product/12345',
  taobao: 'https://taobao.example.test/product/12345?spm=synthetic_foreign',
};

it.each(['jd', 'pdd', 'taobao'] as const)(
  '[AC-B1-06i#5] %s URL 经 parsing 派生登记；淘宝只回解析后的百川商品指令',
  async (platform) => {
    const f = await fixture(database(), platform);
    const convert = service(f);
    const input = f.request();
    const body: Body = { platform, url: urls[platform], scene: 'h5' };
    const data = await success(await convert.convert({ ...input, body }), f);
    expect(f.urlParser.parseUrl).toHaveBeenCalledExactlyOnceWith(
      urls[platform],
      expect.objectContaining({
        appId: f.appId,
        purpose: 'online',
      }),
    );
    expect(f.resolveLink).toHaveBeenCalledTimes(1);
    const parsed = await f.urlParser.parseUrl.mock.results[0]!.value;
    expect((await f.links())[0]).toMatchObject({
      product_key: parsed.ref.productKey,
      raw_item_id: parsed.ref.rawItemId,
    });
    if (platform === 'taobao') {
      expect(data.jump.primary).toMatchObject({
        type: 'sdk',
        value: parsed.ref.rawItemId,
        sdk: {
          provider: 'baichuan',
          open_by: 'code',
          item_id: parsed.ref.rawItemId,
          page: 'detail',
        },
      });
      expect(JSON.stringify(data.jump)).not.toContain(urls.taobao);
      expect(JSON.stringify(data.jump)).not.toContain('synthetic_foreign');
      expect(f.convert).not.toHaveBeenCalled();
    } else {
      expect(f.convert).toHaveBeenCalledTimes(1);
    }
  },
  60_000,
);

it.each(['unsupported', 'underivable'] as const)(
  '[AC-B1-06i#6] URL %s → 30131，未登记 link、未生成 attempt、未转链',
  async (kind) => {
    const f = await fixture(database());
    const url = kind === 'unsupported' ? 'https://unsupported.example.test/product' : urls.jd;
    if (kind === 'underivable') {
      // Recognized platform, but the upstream supplies no identity from which to derive a key.
      f.resolveLink.mockResolvedValue({ item: { platform: 'jd' } });
    }
    const convert = service(f);
    const result = await convert.convert({
      ...f.request(),
      body: { platform: 'jd', url, scene: 'h5' },
    });
    expect(result).toMatchObject({ status: 422, envelope: { code: 30131 } });
    expect(f.urlParser.parseUrl).toHaveBeenCalledTimes(1);
    expect(await f.links()).toEqual([]);
    expect(await f.attempts()).toEqual([]);
    expect(f.convert).not.toHaveBeenCalled();
  },
  60_000,
);
