import { afterEach, expect, it, vi } from 'vitest';
import type { SearchProductsData } from '../../../../apps/api/src/modules/catalog/index.ts';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import { candidate } from '../search/kit.ts';
import { assertContract, headers, httpFixture, type HttpApp } from './http-kit.ts';

let app: HttpApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

it('[AC-B1-05j#1] 游客经真实 HTTP 搜索出卡，响应符合契约且只登记报价链接', async () => {
  const f = await httpFixture();
  app = f.app;
  f.pages.set(1, { items: [candidate('guest')], hasMore: false });
  const response = await f.request();
  expect(response.statusCode).toBe(200);
  await assertContract(response, true);
  const body = response.json<{ code: number; trace_id: string; data: SearchProductsData }>();
  expect(body.code).toBe(0);
  expect(body.trace_id).toBe(response.headers['x-trace-id']);
  expect(body.data).toMatchObject({ has_more: false, next_cursor: null, fallback_items: [] });
  expect(body.data.items).toEqual([
    expect.objectContaining({ title: 'synthetic-guest', link_id: expect.any(String) }),
  ]);
  expect(f.viewers).toEqual([{ appId: 'synthetic-app', userId: null, deviceId: null }]);
  expect(f.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      viewer: { appId: 'synthetic-app', userId: null, deviceId: null },
      entrySource: 'search',
      quote: expect.objectContaining({ rebateMaxFen: 20n }),
    }),
  );
  expect(body.data.items[0]).not.toHaveProperty('click_url');
});

it.each([
  ['platform', 'unknown'],
  ['platform', ''],
  ['q', ''],
  ['q', 'a'.repeat(101)],
  ['sort', 'price_desc'],
  ['has_coupon', '1'],
  ['has_coupon', 'yes'],
  ['price_min_fen', '0'],
  ['price_min_fen', '-1'],
  ['price_min_fen', '1.5'],
  ['price_min_fen', '10000001'],
  ['price_min_fen', 'not-a-number'],
  ['price_max_fen', '0'],
  ['price_max_fen', '-1'],
  ['price_max_fen', '1.5'],
  ['price_max_fen', '10000001'],
  ['price_max_fen', '9007199254740993'],
  ['cursor', 'x'.repeat(513)],
  ['cursor', 'synthetic-malformed-cursor'],
  ['limit', '0'],
  ['limit', '51'],
  ['limit', '1.5'],
  ['limit', 'not-a-number'],
])('[AC-B1-05j#2] HTTP 非法 %s=%s 返回 400/20001 且无业务副作用', async (key, value) => {
  const f = await httpFixture();
  app = f.app;
  const response = await f.request({ [key]: value });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: 20001 });
  await assertContract(response, false);
  expect(f.search).not.toHaveBeenCalled();
  expect(f.materialFeed).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it.each(['platform', 'q'])('[AC-B1-05j#3] HTTP 缺少必填 %s 返回 20001', async (missing) => {
  const f = await httpFixture();
  app = f.app;
  const query = new URLSearchParams({ platform: 'taobao', q: '合成纸巾' });
  query.delete(missing);
  const response = await app.inject({
    method: 'GET',
    url: `/v1/products/search?${query}`,
    headers,
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: 20001 });
  await assertContract(response, false);
  expect(f.search).not.toHaveBeenCalled();
});

it('[AC-B1-05j#4] HTTP 最小价大于最大价返回 20001，不调用联盟', async () => {
  const f = await httpFixture();
  app = f.app;
  const response = await f.request({ price_min_fen: '2', price_max_fen: '1' });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: 20001 });
  await assertContract(response, false);
  expect(f.search).not.toHaveBeenCalled();
});

it.each([
  { price: 1, limit: 1, coupon: true, sort: 'final_price_asc' },
  { price: 10000000, limit: 50, coupon: false, sort: 'rebate_desc' },
  { price: 1000, limit: 20, coupon: false, sort: 'sales_desc' },
  { price: 1000, limit: 20, coupon: true, sort: 'relevance' },
])('[AC-B1-05j#5] HTTP 合法边界与类型转换 $price/$limit/$coupon/$sort', async (input) => {
  const f = await httpFixture();
  app = f.app;
  f.pages.set(1, { items: [candidate('boundary', BigInt(input.price), 1n)], hasMore: false });
  const response = await f.request({
    q: 'a'.repeat(100),
    sort: input.sort,
    limit: String(input.limit),
    has_coupon: String(input.coupon),
    price_min_fen: String(input.price),
    price_max_fen: String(input.price),
  });
  expect(response.statusCode).toBe(200);
  await assertContract(response, true);
  expect(f.calls).toEqual([
    expect.objectContaining({
      q: 'a'.repeat(100),
      sort: input.sort,
      limit: input.limit,
      has_coupon: input.coupon,
      price_min_fen: input.price,
      price_max_fen: input.price,
    }),
  ]);
  expect(response.json<{ data: SearchProductsData }>().data.items).toHaveLength(1);
  expect(f.search).toHaveBeenCalledWith(
    expect.objectContaining({
      priceMinFen: input.price,
      sort: input.sort === 'sales_desc' ? 'sales_desc' : 'relevance',
    }),
  );
  expect(f.search.mock.calls[0]?.[0]).not.toHaveProperty('priceMaxFen');
});

it('[AC-B1-05j#6] HTTP 游标往返传入会话页码，并从后页剔除已下发商品', async () => {
  const f = await httpFixture();
  app = f.app;
  f.pages.set(1, { items: [candidate('first')], hasMore: true });
  f.pages.set(2, { items: [candidate('first'), candidate('second')], hasMore: false });
  const first = await f.request({ limit: '1' });
  expect(first.statusCode).toBe(200);
  await assertContract(first, true);
  const firstData = first.json<{ data: SearchProductsData }>().data;
  expect(firstData).toMatchObject({ has_more: true, next_cursor: expect.any(String) });
  const next = await f.request({ limit: '1', cursor: firstData.next_cursor! });
  expect(next.statusCode).toBe(200);
  await assertContract(next, true);
  expect(next.json<{ data: SearchProductsData }>().data.items.map((item) => item.title)).toEqual([
    'synthetic-second',
  ]);
  expect(f.search.mock.calls.map(([request]) => request.pageNo)).toEqual([1, 2]);
});

it.each(['taobao', 'jd', 'pdd'] as const)(
  '[AC-B1-05j#7] HTTP %s 开关关闭返回 503/50304 与精确 data',
  async (name) => {
    const f = await httpFixture();
    app = f.app;
    f.enabled.set(name, false);
    const response = await f.request({ platform: name });
    expect(response.statusCode).toBe(503);
    await assertContract(response, false);
    expect(response.json<{ code: number; data: unknown }>()).toMatchObject({ code: 50304 });
    expect(response.json<{ data: unknown }>().data).toEqual({
      platform: name,
      reason: 'search_disabled',
    });
    expect(f.search).not.toHaveBeenCalled();
    expect(f.materialFeed).not.toHaveBeenCalled();
  },
);

it('[AC-B1-05j#8] HTTP 耗尽重试的网络故障为 50304，内部错误不泄漏到响应', async () => {
  const f = await httpFixture();
  app = f.app;
  f.search.mockRejectedValue(new Error('synthetic exhausted ECONNRESET at example.test'));
  const response = await f.request();
  expect(response.statusCode).toBe(503);
  await assertContract(response, false);
  expect(response.json<{ code: number; data: unknown }>().code).toBe(50304);
  expect(response.json<{ data: unknown }>().data).toEqual({ platform: 'taobao' });
  expect(JSON.stringify(response.json())).not.toContain('ECONNRESET');
  expect(f.materialFeed).not.toHaveBeenCalled();
});

it('[AC-B1-05j#9] HTTP 无结果给本平台前十个物料，整份响应通过契约', async () => {
  vi.spyOn(platform, 'getMaterialChannels').mockReturnValue({
    version: 'synthetic',
    channels: [
      {
        platform: 'taobao',
        channel_id: 'synthetic-feed',
        name: 'synthetic',
        sort_basis: 'sales',
        selectable: true,
        source: 'synthetic',
      },
    ],
  });
  const f = await httpFixture();
  app = f.app;
  f.materialFeed.mockResolvedValue({
    items: Array.from({ length: 12 }, (_, i) => candidate(`feed-${i}`)),
    hasMore: true,
  });
  const response = await f.request({ price_max_fen: '1' });
  expect(response.statusCode).toBe(200);
  await assertContract(response, true);
  const data = response.json<{ data: SearchProductsData }>().data;
  expect(data).toMatchObject({ items: [], next_cursor: null, has_more: false });
  expect(data.fallback_items.map((card) => card.title)).toEqual(
    Array.from({ length: 10 }, (_, i) => `synthetic-feed-${i}`),
  );
});
