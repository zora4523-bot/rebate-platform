// Task B1-28c §B / CT-22b. Every case reaches an absent route on the baseline and fails an
// assertion (404); authentication, validation and idempotency are never mocked away.
import { afterEach, expect, it, vi } from 'vitest';
import { FavoriteError } from '../../../../apps/api/src/modules/catalog/index.ts';
import { contractAuthOf } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  assertContract,
  batchBody,
  contract,
  favoritePath,
  fixture,
  operations,
  writes,
} from './kit.ts';

let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  try {
    await f?.close();
  } finally {
    f = undefined;
    vi.restoreAllMocks();
  }
}, 30_000);

it.each([{ method: 'GET', url: '/v1/me/favorites' } as const, ...writes])(
  '[AC-B1-28c#1] $method $url 无登录凭据返回 401/10001，不调用收藏用例',
  async (request) => {
    f = await fixture();
    const response = await f.request(request);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: 10001,
      trace_id: '01920000-0000-7000-8000-00000000d028',
    });
    for (const method of Object.values(f.service)) expect(method).not.toHaveBeenCalled();
    await assertContract(response, 'ErrorEnvelope');
  },
  30_000,
);

it.each(operations)(
  '[AC-B1-28c#2] api 恰好注册一次 $id；契约取消 planned，鉴权为 login',
  async ({ method, path, id }) => {
    f = await fixture();
    const routePath = path
      .replaceAll('{platform}', ':platform')
      .replaceAll('{product_key}', ':product_key');
    expect(f.routes.filter((route) => route === `${method} ${routePath}`)).toHaveLength(1);
    expect(f.app.getHttpServer().listening).toBe(false);
    const operation = (await contract()).paths[path]?.[method.toLowerCase()];
    expect(operation).toBeDefined();
    expect(operation).toHaveProperty('operationId', id);
    expect(operation).toMatchObject({ 'x-auth': 'login', security: [{ bearerAuth: [] }] });
    expect(operation).not.toHaveProperty('x-implementation');
    expect(contractAuthOf(method, routePath)).toBe('login');
  },
  30_000,
);

it.each(writes)(
  '[AC-B1-28c#3] $method 同键重放保持原响应，使用会话用户而非伪造头',
  async (request) => {
    f = await fixture();
    const authorization = await f.memberAuthorization();
    const first = await f.request(
      { ...request, headers: { 'x-user-id': 'synthetic-outsider' } },
      authorization,
    );
    expect(first.statusCode).toBe(200);
    const second = await f.request(request, authorization);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ code: 0, msg: '' });
    expect(second.json()).toEqual({
      code: 0,
      msg: '',
      data:
        request.method === 'PUT'
          ? {
              platform: 'taobao',
              product_key: 'tb:favorite001',
              favorited_at: '2030-10-01T01:30:00.000Z',
            }
          : {},
      trace_id: '01920000-0000-7000-8000-00000000d028',
    });
    if (request.method === 'PUT') {
      expect(first.json()).toEqual({
        code: 0,
        msg: '',
        data: {
          platform: 'taobao',
          product_key: 'tb:favorite001',
          favorited_at: '2030-10-01T01:30:00.000Z',
        },
        trace_id: '01920000-0000-7000-8000-00000000d028',
      });
      expect(f.service.addFavorite).toHaveBeenCalledExactlyOnceWith(
        'synthetic_favorites',
        '01920000-0000-7000-8000-000000000011',
        'taobao',
        'tb:favorite001',
      );
    } else {
      expect(first.json()).toEqual({
        code: 0,
        msg: '',
        data: {},
        trace_id: '01920000-0000-7000-8000-00000000d028',
      });
      if (request.method === 'DELETE') {
        expect(f.service.removeFavorite).toHaveBeenCalledExactlyOnceWith(
          'synthetic_favorites',
          '01920000-0000-7000-8000-000000000011',
          'taobao',
          'tb:favorite001',
        );
      } else {
        expect(f.service.removeFavorites).toHaveBeenCalledExactlyOnceWith(
          'synthetic_favorites',
          '01920000-0000-7000-8000-000000000011',
          [
            { platform: 'taobao', productKey: 'tb:favorite001' },
            { platform: 'jd', productKey: 'jd:favorite002' },
          ],
        );
      }
    }
    expect(first.headers['x-trace-id']).toBe('01920000-0000-7000-8000-00000000d028');
    expect(f.service.deleteAllFavoritesOfUser).not.toHaveBeenCalled();
    await assertContract(first, request.method === 'PUT' ? 'FavoriteResponse' : 'EmptyResponse');
    await assertContract(second, request.method === 'PUT' ? 'FavoriteResponse' : 'EmptyResponse');
  },
  30_000,
);

it('[AC-B1-28c#4] 已收藏再次使用新幂等键添加仍返回用例的原收藏时间', async () => {
  f = await fixture();
  const authorization = await f.memberAuthorization();
  for (const key of ['favorite-existing-01', 'favorite-existing-02']) {
    const response = await f.request({ method: 'PUT', url: favoritePath }, authorization, key);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      code: 0,
      msg: '',
      data: {
        platform: 'taobao',
        product_key: 'tb:favorite001',
        favorited_at: '2030-10-01T01:30:00.000Z',
      },
      trace_id: '01920000-0000-7000-8000-00000000d028',
    });
    await assertContract(response, 'FavoriteResponse');
  }
  expect(f.service.addFavorite).toHaveBeenCalledTimes(2);
}, 30_000);

it.each(writes)(
  '[AC-B1-28c#5] $method 相同幂等键在两个登录用户之间不串用，也不固定首个用户',
  async (request) => {
    f = await fixture();
    for (const uid of [
      '01920000-0000-7000-8000-000000000011',
      '01920000-0000-7000-8000-000000000012',
    ]) {
      const response = await f.request(request, await f.memberAuthorization(uid));
      expect(response.statusCode).toBe(200);
      await assertContract(
        response,
        request.method === 'PUT' ? 'FavoriteResponse' : 'EmptyResponse',
      );
    }
    const calls =
      request.method === 'PUT'
        ? f.service.addFavorite.mock.calls
        : request.method === 'DELETE'
          ? f.service.removeFavorite.mock.calls
          : f.service.removeFavorites.mock.calls;
    expect(calls.map(([appId, userId]) => [appId, userId])).toEqual([
      ['synthetic_favorites', '01920000-0000-7000-8000-000000000011'],
      ['synthetic_favorites', '01920000-0000-7000-8000-000000000012'],
    ]);
  },
  30_000,
);

it.each(
  writes.flatMap((request) =>
    [null, 'short', 'bad.key.0001', 'x'.repeat(65)].map((key) => ({ ...request, key })),
  ),
)(
  '[AC-B1-28c#6] $method 缺失或非法幂等键 $key 返回 20001，不调用写用例',
  async ({ key, ...request }) => {
    f = await fixture();
    const response = await f.request(request, await f.memberAuthorization(), key);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001, data: { fields: ['idempotency-key'] } });
    expect(f.service.addFavorite).not.toHaveBeenCalled();
    expect(f.service.removeFavorite).not.toHaveBeenCalled();
    expect(f.service.removeFavorites).not.toHaveBeenCalled();
    await assertContract(response, 'ErrorEnvelope');
  },
  30_000,
);

it('[AC-B1-28c#7] 新增超限时保留 FavoriteError 的 favorites_full 原因', async () => {
  f = await fixture();
  f.service.addFavorite.mockRejectedValue(new FavoriteError({ reason: 'favorites_full' }));
  const response = await f.request(
    { method: 'PUT', url: favoritePath },
    await f.memberAuthorization(),
  );
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: 20001, data: { reason: 'favorites_full' } });
  expect(f.service.addFavorite).toHaveBeenCalledTimes(1);
  await assertContract(response, 'ErrorEnvelope');
}, 30_000);

it.each(['PUT', 'DELETE'] as const)(
  '[AC-B1-28c#8] %s 拒绝非平台枚举，不调用收藏用例',
  async (method) => {
    f = await fixture();
    const response = await f.request(
      { method, url: '/v1/me/favorites/unknown/tb%3Afavorite001' },
      await f.memberAuthorization(),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001, data: { fields: ['platform'] } });
    expect(f.service.addFavorite).not.toHaveBeenCalled();
    expect(f.service.removeFavorite).not.toHaveBeenCalled();
    await assertContract(response, 'ErrorEnvelope');
  },
  30_000,
);

it.each(
  (['PUT', 'DELETE'] as const).flatMap((method) =>
    [
      'x',
      'missing-colon',
      'tb:',
      'TB:favorite001',
      'tb:has space',
      'jd:favorite002',
      'unknown:favorite003',
    ].map((key) => ({ method, key })),
  ),
)(
  '[AC-B1-28c#9] $method 非法形状或平台前缀 $key 返回 product_key 字段错误',
  async ({ method, key }) => {
    f = await fixture();
    const response = await f.request(
      { method, url: `/v1/me/favorites/taobao/${encodeURIComponent(key)}` },
      await f.memberAuthorization(),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001, data: { fields: ['product_key'] } });
    expect(f.service.addFavorite).not.toHaveBeenCalled();
    expect(f.service.removeFavorite).not.toHaveBeenCalled();
    await assertContract(response, 'ErrorEnvelope');
  },
  30_000,
);

it('[AC-B1-28c#10] batch-delete 超过 100 项在调用用例前拒绝，fields 指向 items', async () => {
  f = await fixture();
  const response = await f.request(
    {
      method: 'POST',
      url: '/v1/me/favorites/batch-delete',
      payload: {
        items: Array.from({ length: 101 }, (_, index) => ({
          platform: 'taobao',
          product_key: `tb:favorite${index}`,
        })),
      },
    },
    await f.memberAuthorization(),
  );
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: 20001, data: { fields: ['items'] } });
  expect(f.service.removeFavorites).not.toHaveBeenCalled();
  await assertContract(response, 'ErrorEnvelope');
}, 30_000);

it('[AC-B1-28c#11] batch-delete 恰好 100 项成功，首尾键完整传递给同一用户的用例', async () => {
  f = await fixture();
  const response = await f.request(
    {
      method: 'POST',
      url: '/v1/me/favorites/batch-delete',
      payload: {
        items: Array.from({ length: 100 }, (_, index) => ({
          platform: 'taobao',
          product_key: `tb:favorite${index}`,
        })),
      },
    },
    await f.memberAuthorization(),
  );
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: {} });
  expect(f.service.removeFavorites).toHaveBeenCalledTimes(1);
  const args = f.service.removeFavorites.mock.calls[0];
  expect(args?.slice(0, 2)).toEqual([
    'synthetic_favorites',
    '01920000-0000-7000-8000-000000000011',
  ]);
  expect(args?.[2]).toHaveLength(100);
  expect(args?.[2][0]).toEqual({ platform: 'taobao', productKey: 'tb:favorite0' });
  expect(args?.[2][99]).toEqual({ platform: 'taobao', productKey: 'tb:favorite99' });
  await assertContract(response, 'EmptyResponse');
}, 30_000);

it.each([
  { items: [] },
  {},
  { items: 'invalid' },
  { items: [{ platform: 'unknown', product_key: 'tb:favorite001' }] },
  { items: [{ platform: 'taobao', product_key: 'tb:' }] },
  { items: [{ platform: 'taobao', product_key: 'jd:favorite002' }] },
  { items: [{ platform: 'taobao' }] },
  { ...batchBody, user_id: 'synthetic-outsider' },
  { items: [{ platform: 'taobao', product_key: 'tb:favorite001', user_id: 'synthetic-outsider' }] },
])(
  '[AC-B1-28c#12] 批量删除拒绝非法 body %j，不能靠 body 注入用户范围',
  async (payload) => {
    f = await fixture();
    const response = await f.request(
      { method: 'POST', url: '/v1/me/favorites/batch-delete', payload },
      await f.memberAuthorization(),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001 });
    expect(response.json<{ data?: { fields?: string[] } }>().data?.fields?.length).toBeGreaterThan(
      0,
    );
    expect(f.service.removeFavorites).not.toHaveBeenCalled();
    await assertContract(response, 'ErrorEnvelope');
  },
  30_000,
);

it.each(writes)(
  '[AC-B1-28c#13] $method 不能通过 query 注入 user_id',
  async (request) => {
    f = await fixture();
    const response = await f.request(
      { ...request, url: `${request.url}?user_id=synthetic-outsider` },
      await f.memberAuthorization(),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001 });
    expect(f.service.addFavorite).not.toHaveBeenCalled();
    expect(f.service.removeFavorite).not.toHaveBeenCalled();
    expect(f.service.removeFavorites).not.toHaveBeenCalled();
    await assertContract(response, 'ErrorEnvelope');
  },
  30_000,
);
