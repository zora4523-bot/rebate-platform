// B1-01zze: exercise bootstrap's real router, request validator and error envelope.
// The existing fixture replaces storage ports only; no listener, database or network is used.
import { afterEach, expect, it, vi } from 'vitest';
import { CATALOG } from '../../../../../apps/api/src/modules/catalog/catalog.module.ts';
import { assertContract, fixture, headers } from '../../../catalog/price-trend-route/kit.ts';

let app: Awaited<ReturnType<typeof fixture>>['app'] | undefined;
afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = undefined;
    vi.restoreAllMocks();
  }
});

function productKey(length: number): string {
  // A 128-character key needs a three-letter prefix: stable_id is limited to 124.
  const prefix = length === 128 ? 'pdd' : 'tb';
  return `${prefix}:${'x'.repeat(length - prefix.length - 1)}`;
}

function request(key: string, encoded: boolean) {
  const segment = encoded ? encodeURIComponent(key) : key;
  const platform = key.startsWith('pdd:') ? 'pdd' : 'taobao';
  return {
    method: 'GET' as const,
    url: `/v1/products/${segment}/price-trend?platform=${platform}`,
    headers,
  };
}

it.each([
  { ac: 1, length: 101, encoded: false },
  { ac: 2, length: 101, encoded: true },
  { ac: 3, length: 128, encoded: false },
  { ac: 4, length: 128, encoded: true },
])(
  '[AC-B1-01zze#$ac] 合法 $length 字符键到达处理函数，冒号编码=$encoded；短键行为不变',
  async ({ length, encoded }) => {
    const f = await fixture();
    app = f.app;
    // Keep the control requests in the same case as the regression: each case must be red
    // on the old router, while still checking the previous <=100-character behavior on green.
    for (const size of [length, 4, 99, 100]) {
      const key = productKey(size);
      f.read.mockClear();
      const response = await app.inject(request(key, encoded));
      expect(response.statusCode, `product_key length=${size}, encoded=${encoded}`).not.toBe(414);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json\b/);
      expect(response.headers['x-trace-id']).toBe(headers['x-trace-id']);
      expect(response.json()).toMatchObject({ code: 0, trace_id: headers['x-trace-id'] });
      expect(f.read).toHaveBeenCalledTimes(1);
      expect(f.read.mock.calls[0]?.[1]).toMatchObject({ productKey: key });
      await assertContract(response, 'ProductPriceTrendResponse');
    }
  },
  30_000,
);

it.each([
  { ac: 5, length: 129, encoded: false },
  { ac: 6, length: 129, encoded: true },
  { ac: 7, length: 300, encoded: false },
  { ac: 8, length: 300, encoded: true },
])(
  '[AC-B1-01zze#$ac] 超长 $length 字符键由契约校验返回 20001，冒号编码=$encoded',
  async ({ length, encoded }) => {
    const f = await fixture();
    app = f.app;
    // The controller reads the platform dictionary before its own ProductKey check.
    // No dictionary read proves rejection happened before that business fallback.
    const catalog = app.get<{ listPlatforms(): Promise<unknown> }>(CATALOG);
    const listPlatforms = vi.spyOn(catalog, 'listPlatforms');
    const response = await app.inject(request(productKey(length), encoded));
    expect(response.statusCode).not.toBe(414);
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toMatch(/^application\/json\b/);
    expect(response.headers['x-trace-id']).toBe(headers['x-trace-id']);
    expect(response.json()).toMatchObject({
      code: 20001,
      msg: expect.any(String),
      trace_id: headers['x-trace-id'],
      data: { fields: ['product_key'] },
    });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.rows).not.toHaveBeenCalled();
    expect(listPlatforms).not.toHaveBeenCalled();
    await assertContract(response, 'ErrorEnvelope');
  },
  30_000,
);
