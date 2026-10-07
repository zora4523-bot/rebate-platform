import { expect, it, vi } from 'vitest';
import { createTokenCheck } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { tokenPrincipal } from '../../../../apps/api/src/modules/platform/http/token-context.ts';
import {
  contractAuthOf,
  contractAuthRoutes,
} from '../../../../apps/api/src/modules/platform/http/auth-routes.ts';
import { PRINCIPAL, HEADERS, fixture, request, routeFor, routes } from './kit.ts';

function guard() {
  const setup = fixture();
  const find = vi.fn(async () => ({
    revoked_at: null as Date | null,
  }));
  const check = createTokenCheck({ tokens: setup.tokens, sessions: { find } });
  return { ...setup, check, find };
}

it('[04 §5][BR-ID-01] x-auth全表与契约精确一致，包括planned；HEAD沿用GET', async () => {
  const expected = (await routes()).map(({ method, path, auth }) => ({ method, path, auth }));
  expect(expected.length).toBeGreaterThan(0);
  const order = (a: { method: string; path: string }, b: { method: string; path: string }) =>
    `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`);
  expect([...contractAuthRoutes()].sort(order)).toEqual(expected.sort(order));
  for (const route of expected) {
    expect(contractAuthOf(route.method, route.path)).toBe(route.auth);
    if (
      route.method === 'GET' &&
      !expected.some((candidate) => candidate.method === 'HEAD' && candidate.path === route.path)
    )
      expect(contractAuthOf('HEAD', route.path)).toBe(route.auth);
  }
  expect(contractAuthOf('GET', '/outside-the-contract')).toBeUndefined();
}, 30_000);

it('[BR-ID-01][04 §5] 契约外路由不读Authorization、不查询会话，②③直接放行', async () => {
  const route = { method: 'GET', path: '/outside-the-contract' };
  expect(contractAuthOf(route.method, route.path)).toBeUndefined();
  const { check, find } = guard();
  const input = request(route, { 'x-app-id': 'other-app' });
  const readAuthorization = vi.fn(() => 'Bearer invalid-token');
  Object.defineProperty(input.headers, 'authorization', { get: readAuthorization });
  // Even a device context must not accidentally opt a non-contract route into stage ③.
  input.verifiedDevice = { deviceId: PRINCIPAL.device_id, appId: PRINCIPAL.app_id };
  await check(input);
  expect(readAuthorization).not.toHaveBeenCalled();
  expect(find).not.toHaveBeenCalled();
  expect(tokenPrincipal(input)).toBeUndefined();
});

it('[BR-ID-01][04 §5] 全部login/phone/realname操作缺令牌回10001，none/optional缺令牌通过', async () => {
  const { check, find } = guard();
  for (const route of await routes()) {
    const input = request(route);
    if (route.signed)
      input.verifiedDevice = { deviceId: PRINCIPAL.device_id, appId: PRINCIPAL.app_id };
    if (route.auth === 'none' || route.auth === 'optional') {
      await check(input);
      expect(tokenPrincipal(input)).toBeUndefined();
    } else {
      await expect(check(input)).rejects.toMatchObject({ code: 10001, statusCode: 401 });
    }
  }
  expect(find).not.toHaveBeenCalled();
}, 30_000);

for (const authorization of [
  '',
  'Basic password',
  'Bearer',
  'Bearer ',
  'Bearer invalid',
  ['Bearer one', 'Bearer two'],
] as const) {
  it(`[BR-ID-01] 异常Authorization ${JSON.stringify(authorization)} 返回10002`, async () => {
    const { check } = guard();
    const input = request(await routeFor('login'), {
      ...HEADERS,
      authorization: typeof authorization === 'string' ? authorization : [...authorization],
    });
    await expect(check(input)).rejects.toMatchObject({ code: 10002, statusCode: 401 });
  });
}

it('[BR-ID-01][04 §5] optional带有效令牌建立服务端主体，坏令牌回10002；none完全忽略Authorization', async () => {
  const { check, tokens, find } = guard();
  const token = await tokens.issueAccess(PRINCIPAL);
  const input = request(await routeFor('optional'), {
    ...HEADERS,
    authorization: `Bearer ${token}`,
  });
  await check(input);
  expect(tokenPrincipal(input)).toEqual(PRINCIPAL);
  await expect(
    check(request(await routeFor('optional'), { ...HEADERS, authorization: 'Bearer broken' })),
  ).rejects.toMatchObject({ code: 10002 });
  find.mockClear();
  for (const route of (await routes()).filter((entry) => entry.auth === 'none')) {
    const anonymous = request(route, { ...HEADERS, authorization: 'Bearer expired.invalid.token' });
    if (route.signed) anonymous.verifiedDevice = { deviceId: PRINCIPAL.device_id, appId: 'couli' };
    await check(anonymous);
    expect(tokenPrincipal(anonymous)).toBeUndefined();
  }
  expect(find).not.toHaveBeenCalled();
}, 30_000);

it('[BR-ID-01][BR-ID-07] 每次请求查sid，同一令牌在会话吊销后立刻10002', async () => {
  const { check, tokens, find, clock } = guard();
  const route = await routeFor('login');
  const token = await tokens.issueAccess(PRINCIPAL);
  const headers = { ...HEADERS, authorization: `Bearer ${token}` };
  const first = request(route, headers);
  await check(first);
  expect(tokenPrincipal(first)).toEqual(PRINCIPAL);
  find.mockResolvedValue({
    revoked_at: clock.now(),
  });
  await expect(check(request(route, headers))).rejects.toMatchObject({ code: 10002 });
  expect(find).toHaveBeenCalledTimes(2);
  expect(find).toHaveBeenNthCalledWith(1, PRINCIPAL.app_id, PRINCIPAL.sid);
  expect(find).toHaveBeenNthCalledWith(2, PRINCIPAL.app_id, PRINCIPAL.sid);
});

it('[BR-ID-01] 不存在的sid拒绝为10002；库故障不放行、不伪装为令牌过期', async () => {
  const { tokens } = fixture();
  const route = await routeFor('login');
  const input = request(route, {
    ...HEADERS,
    authorization: `Bearer ${await tokens.issueAccess(PRINCIPAL)}`,
  });
  await expect(
    createTokenCheck({ tokens, sessions: { find: async () => null } })(input),
  ).rejects.toMatchObject({ code: 10002 });
  const failure = new Error('session-store-unavailable');
  await expect(
    createTokenCheck({
      tokens,
      sessions: {
        find: async () => {
          throw failure;
        },
      },
    })(input),
  ).rejects.toBe(failure);
});

for (const app of [undefined, 'another-app']) {
  it(`[BR-ID-01][BR-ID-07] 带令牌缺失/错App ${String(app)} →10403；坏令牌优先10002`, async () => {
    const { check, tokens } = guard();
    const route = await routeFor('login');
    const headers = {
      ...HEADERS,
      'x-app-id': app,
      authorization: `Bearer ${await tokens.issueAccess(PRINCIPAL)}`,
    };
    await expect(check(request(route, headers))).rejects.toMatchObject({
      code: 10403,
      statusCode: 403,
    });
    await expect(
      check(request(route, { ...headers, authorization: 'Bearer broken' })),
    ).rejects.toMatchObject({ code: 10002 });
  });
}

it('[BR-ID-01][BR-ID-07] 匿名签名请求以verifiedDevice校验App，none即使带令牌仍走设备来源', async () => {
  const { check, tokens } = guard();
  for (const auth of ['none', 'optional'] as const) {
    const route = await routeFor(auth, true);
    for (const app of [undefined, 'other']) {
      const input = request(route, {
        ...HEADERS,
        'x-app-id': app,
        ...(auth === 'none'
          ? {
              authorization: `Bearer ${await tokens.issueAccess({ ...PRINCIPAL, app_id: 'other' })}`,
            }
          : {}),
      });
      input.verifiedDevice = { deviceId: PRINCIPAL.device_id, appId: 'couli' };
      await expect(check(input)).rejects.toMatchObject({ code: 10403, statusCode: 403 });
    }
  }
}, 30_000);

it('[BR-ID-07] deletion_only主体能通过②③，受限接口的10405留给④a；头部不能覆盖主体', async () => {
  const { check, tokens } = guard();
  const expected = { ...PRINCIPAL, scp: 'deletion_only' as const };
  const input = request(await routeFor('login'), {
    ...HEADERS,
    authorization: `Bearer ${await tokens.issueAccess(expected)}`,
    'x-user-id': 'attacker',
    'x-session-id': 'attacker',
    'x-session-scope': 'full',
  });
  await check(input);
  expect(tokenPrincipal(input)).toEqual(expected);
});
