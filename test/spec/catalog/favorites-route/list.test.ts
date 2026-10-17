import { afterEach, expect, it, vi } from 'vitest';
import { FavoriteError } from '../../../../apps/api/src/modules/catalog/index.ts';
import { assertContract, detailCard, fixture } from './kit.ts';

let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  try {
    await f?.close();
  } finally {
    f = undefined;
    vi.restoreAllMocks();
  }
}, 30_000);

it('[AC-B1-28c#14] 列表透传 opaque cursor，保留顺序、next_cursor，失效卡只有标题和图片', async () => {
  f = await fixture();
  f.service.listFavorites.mockResolvedValue({
    items: [
      {
        platform: 'taobao',
        productKey: 'tb:favorite001',
        favoritedAt: new Date('2030-10-01T01:30:00.000Z'),
        invalid: false,
        productCard: { ...detailCard },
      },
      {
        platform: 'jd',
        productKey: 'jd:favorite002',
        favoritedAt: new Date('2030-09-30T02:00:00.000Z'),
        invalid: true,
        productCard: { title: '已下架合成商品', image: 'https://img.example.test/old.jpg' },
      },
    ],
    nextCursor: 'synthetic-next-cursor',
  });
  const response = await f.request(
    {
      method: 'GET',
      url: '/v1/me/favorites?cursor=opaque%2Bcursor%2F%3D',
      headers: { 'x-user-id': 'synthetic-outsider' },
    },
    await f.memberAuthorization(),
  );
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    code: 0,
    msg: '',
    data: {
      items: [
        {
          platform: 'taobao',
          product_key: 'tb:favorite001',
          favorited_at: '2030-10-01T01:30:00.000Z',
          invalid: false,
          product_card: {
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
          },
        },
        {
          platform: 'jd',
          product_key: 'jd:favorite002',
          favorited_at: '2030-09-30T02:00:00.000Z',
          invalid: true,
          product_card: { title: '已下架合成商品', image: 'https://img.example.test/old.jpg' },
        },
      ],
      next_cursor: 'synthetic-next-cursor',
    },
    trace_id: '01920000-0000-7000-8000-00000000d028',
  });
  expect(f.service.listFavorites).toHaveBeenCalledExactlyOnceWith(
    {
      appId: 'synthetic_favorites',
      userId: '01920000-0000-7000-8000-000000000011',
      deviceId: '01920000-0000-7000-8000-00000000d001',
    },
    'opaque+cursor/=',
  );
  expect(f.service.addFavorite).not.toHaveBeenCalled();
  expect(f.service.removeFavorite).not.toHaveBeenCalled();
  expect(f.service.removeFavorites).not.toHaveBeenCalled();
  await assertContract(response, 'FavoriteListResponse');
}, 30_000);

it('[AC-B1-28c#15] 首屏 cursor 为 null，空列表原样返回 items=[]、next_cursor=null，身份逐请求隔离', async () => {
  f = await fixture();
  for (const uid of [
    '01920000-0000-7000-8000-000000000011',
    '01920000-0000-7000-8000-000000000012',
  ]) {
    const response = await f.request(
      { method: 'GET', url: '/v1/me/favorites' },
      await f.memberAuthorization(uid),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      code: 0,
      msg: '',
      data: { items: [], next_cursor: null },
      trace_id: '01920000-0000-7000-8000-00000000d028',
    });
    await assertContract(response, 'FavoriteListResponse');
  }
  expect(f.service.listFavorites.mock.calls).toEqual([
    [
      {
        appId: 'synthetic_favorites',
        userId: '01920000-0000-7000-8000-000000000011',
        deviceId: '01920000-0000-7000-8000-00000000d001',
      },
      null,
    ],
    [
      {
        appId: 'synthetic_favorites',
        userId: '01920000-0000-7000-8000-000000000012',
        deviceId: '01920000-0000-7000-8000-00000000d001',
      },
      null,
    ],
  ]);
}, 30_000);

it('[AC-B1-28c#16] 坏游标的用例错误映射为 400/20001，fields 保留 cursor', async () => {
  f = await fixture();
  f.service.listFavorites.mockRejectedValue(new FavoriteError({ fields: ['cursor'] }));
  const response = await f.request(
    { method: 'GET', url: '/v1/me/favorites?cursor=malformed-cursor' },
    await f.memberAuthorization(),
  );
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: 20001, data: { fields: ['cursor'] } });
  expect(f.service.listFavorites.mock.calls[0]?.[1]).toBe('malformed-cursor');
  await assertContract(response, 'ErrorEnvelope');
}, 30_000);

it.each(['user_id=synthetic-outsider', 'app_id=synthetic_other'])(
  '[AC-B1-28c#17] 列表拒绝契约之外的 query %s，不能覆盖会话范围',
  async (query) => {
    f = await fixture();
    const response = await f.request(
      { method: 'GET', url: `/v1/me/favorites?${query}` },
      await f.memberAuthorization(),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001 });
    expect(f.service.listFavorites).not.toHaveBeenCalled();
    await assertContract(response, 'ErrorEnvelope');
  },
  30_000,
);
