// B1-01zzq: contract routes of the api entry behind the real request checks (D10-396 ③). Reuses
// the B1-28c fixture (test/spec/catalog/favorites-route/kit.ts, imported only): real bootstrap,
// JWT verification and token check; use cases, session lookup and storage are stand-ins, so no
// database, Redis or listener. GET /v1/me/favorites is x-auth login; GET /v1/products/{key} is
// x-auth optional, so the same route answers a guest and a member. Neither sets Cache-Control.
import { afterEach, expect, it, vi } from 'vitest';
import { FavoriteError } from '../../../../../apps/api/src/modules/catalog/index.ts';
import { fixture } from '../../../catalog/favorites-route/kit.ts';
import { NO_STORE, cacheControl } from './kit.ts';

const TRACE = '01920000-0000-7000-8000-00000000d028';
const PRODUCT = '/v1/products/tb%3Afavorite001';

let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  try {
    await f?.close();
  } finally {
    f = undefined;
    vi.restoreAllMocks();
  }
}, 30_000);

it('[AC-B1-01zzq#10] 登录接口 GET /v1/me/favorites：App 令牌的成功与错误响应都带 no-store', async () => {
  f = await fixture();
  const authorization = await f.memberAuthorization();
  const ok = await f.request({ method: 'GET', url: '/v1/me/favorites' }, authorization);
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toMatchObject({ code: 0, data: { items: [], next_cursor: null } });
  expect(cacheControl(ok)).toBe(NO_STORE);
  expect(ok.headers['x-trace-id']).toBe(TRACE);

  f.service.listFavorites.mockRejectedValueOnce(new FavoriteError({ fields: ['cursor'] }));
  const refused = await f.request(
    { method: 'GET', url: '/v1/me/favorites?cursor=malformed-cursor' },
    authorization,
  );
  expect(refused.statusCode).toBe(400);
  expect(refused.json()).toMatchObject({ code: 20001, data: { fields: ['cursor'] } });
  expect(cacheControl(refused)).toBe(NO_STORE);
  expect(refused.headers['x-trace-id']).toBe(TRACE);
}, 30_000);

it('[AC-B1-01zzq#11] 可选登录接口 GET /v1/products/{key}：带令牌带 no-store，游客与伪造用户头不加', async () => {
  f = await fixture();
  const member = await f.request({ method: 'GET', url: PRODUCT }, await f.memberAuthorization());
  expect(member.statusCode).toBe(200);
  expect(member.json()).toMatchObject({ code: 0, data: { product_key: 'tb:favorite001' } });
  expect(cacheControl(member)).toBe(NO_STORE);

  const guests: Record<string, string>[] = [
    {},
    { 'x-user-id': '01920000-0000-7000-8000-000000000011' },
  ];
  for (const headers of guests) {
    const guest = await f.request({ method: 'GET', url: PRODUCT, headers });
    expect(guest.statusCode, JSON.stringify(headers)).toBe(200);
    expect(guest.json(), JSON.stringify(headers)).toMatchObject({
      code: 0,
      data: { product_key: 'tb:favorite001' },
    });
    expect(cacheControl(guest), JSON.stringify(headers)).toBeUndefined();
    expect(guest.headers['x-trace-id'], JSON.stringify(headers)).toBe(TRACE);
  }
}, 30_000);
