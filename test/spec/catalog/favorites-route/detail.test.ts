import { afterEach, expect, it, vi } from 'vitest';
import { assertContract, fixture } from './kit.ts';

let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  try {
    await f?.close();
  } finally {
    f = undefined;
    vi.restoreAllMocks();
  }
}, 30_000);

it('[AC-B1-28c#18] 登录用户已收藏：favorited=true，详情其余字段和详情用例入参不变', async () => {
  f = await fixture();
  f.service.isFavorited.mockResolvedValue(true);
  const response = await f.request(
    {
      method: 'GET',
      url: '/v1/products/tb%3Afavorite001?item_ref=synthetic-reference',
      headers: { 'x-user-id': 'synthetic-outsider' },
    },
    await f.memberAuthorization(),
  );
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    code: 0,
    msg: '',
    data: {
      product_key: 'tb:favorite001',
      item_ref: 'synthetic-reference',
      platform: 'taobao',
      title: '合成收藏商品',
      image: 'https://img.example.test/favorite.jpg',
      price_fen: 3990,
      coupon_fen: 1000,
      final_price_fen: 2990,
      est_net_price_fen: 2790,
      rebate_min_fen: 200,
      rebate_max_fen: 200,
      rebate_basis: 'normal',
      benefit_tags: [],
      is_presale: false,
      link_id: '01920000-0000-7000-8000-000000000028',
      cta: { text_key: 'btn.buy.coupon' },
      quoted_at: '2030-10-17T04:00:00.000Z',
      stale: false,
      age_sec: 0,
      source: 'taobao_union',
      disclaimer_keys: ['price_basis'],
      availability: 'ok',
      favorited: true,
    },
    trace_id: '01920000-0000-7000-8000-00000000d028',
  });
  expect(f.detail).toHaveBeenCalledExactlyOnceWith({
    product_key: 'tb:favorite001',
    item_ref: 'synthetic-reference',
  });
  expect(f.service.isFavorited).toHaveBeenCalledExactlyOnceWith(
    'synthetic_favorites',
    '01920000-0000-7000-8000-000000000011',
    'taobao',
    'tb:favorite001',
  );
  await assertContract(response, 'ProductResponse');
}, 30_000);

it('[AC-B1-28c#19] 登录但未收藏：明确返回 favorited=false，不能省略该字段', async () => {
  f = await fixture();
  const response = await f.request(
    { method: 'GET', url: '/v1/products/tb%3Afavorite001' },
    await f.memberAuthorization(),
  );
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: { favorited: false } });
  expect(f.service.isFavorited).toHaveBeenCalledExactlyOnceWith(
    'synthetic_favorites',
    '01920000-0000-7000-8000-000000000011',
    'taobao',
    'tb:favorite001',
  );
  await assertContract(response, 'ProductResponse');
}, 30_000);

it('[AC-B1-28c#20] 游客详情 favorited=false，伪造用户头不能变成登录身份', async () => {
  f = await fixture();
  f.service.isFavorited.mockImplementation(async (_appId, userId) => userId !== null);
  const response = await f.request({
    method: 'GET',
    url: '/v1/products/tb%3Afavorite001',
    headers: { 'x-user-id': '01920000-0000-7000-8000-000000000011' },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: { favorited: false } });
  // Either skip the lookup for a guest or call the public use case with its documented null UID.
  for (const args of f.service.isFavorited.mock.calls) {
    expect(args).toEqual(['synthetic_favorites', null, 'taobao', 'tb:favorite001']);
  }
  await assertContract(response, 'ProductResponse');
}, 30_000);

it('[AC-B1-28c#21] 收藏状态读取失败降级为 false，详情继续成功并记录警告或错误日志', async () => {
  f = await fixture();
  f.service.isFavorited.mockRejectedValue(new Error('synthetic favorites read failure'));
  const before = f.lines.length;
  const response = await f.request(
    { method: 'GET', url: '/v1/products/tb%3Afavorite001' },
    await f.memberAuthorization(),
  );
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    code: 0,
    data: {
      favorited: false,
      product_key: 'tb:favorite001',
      title: '合成收藏商品',
      price_fen: 3990,
      coupon_fen: 1000,
      final_price_fen: 2990,
      rebate_min_fen: 200,
      rebate_max_fen: 200,
      link_id: '01920000-0000-7000-8000-000000000028',
      availability: 'ok',
    },
  });
  expect(f.service.isFavorited).toHaveBeenCalledTimes(1);
  expect(f.detail).toHaveBeenCalledTimes(1);
  expect(
    f.lines
      .slice(before)
      .map((line) => JSON.parse(line) as { level: number })
      .some((line) => line.level >= 40),
  ).toBe(true);
  await assertContract(response, 'ProductResponse');
}, 30_000);

it('[AC-B1-28c#22] 同一商品的已收藏用户、另一未收藏用户和游客之间不串 favorited', async () => {
  f = await fixture();
  f.service.isFavorited.mockImplementation(
    async (_appId, userId) => userId === '01920000-0000-7000-8000-000000000011',
  );
  const first = await f.request(
    { method: 'GET', url: '/v1/products/tb%3Afavorite001' },
    await f.memberAuthorization(),
  );
  expect(first.statusCode).toBe(200);
  expect(first.json()).toMatchObject({ data: { favorited: true } });
  const second = await f.request(
    { method: 'GET', url: '/v1/products/tb%3Afavorite001' },
    await f.memberAuthorization('01920000-0000-7000-8000-000000000012'),
  );
  expect(second.statusCode).toBe(200);
  expect(second.json()).toMatchObject({ data: { favorited: false } });
  const guest = await f.request({ method: 'GET', url: '/v1/products/tb%3Afavorite001' });
  expect(guest.statusCode).toBe(200);
  expect(guest.json()).toMatchObject({ data: { favorited: false } });
  expect(f.service.isFavorited.mock.calls.filter(([, userId]) => userId !== null)).toEqual([
    ['synthetic_favorites', '01920000-0000-7000-8000-000000000011', 'taobao', 'tb:favorite001'],
    ['synthetic_favorites', '01920000-0000-7000-8000-000000000012', 'taobao', 'tb:favorite001'],
  ]);
  for (const response of [first, second, guest]) await assertContract(response, 'ProductResponse');
}, 30_000);
