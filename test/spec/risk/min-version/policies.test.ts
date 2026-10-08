import { expect, it } from 'vitest';
import { contractMinimumVersionRoutes } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  CONDITIONAL,
  HEADERS,
  PRINCIPAL,
  contractRoutes,
  expectBlocked,
  fixture,
  forRoute,
  request,
} from './kit.ts';

it('[AC-B1-03c#5] 生成的 operation 策略完整匹配契约 gate、scope 与幂等扩展（含 planned）', async () => {
  const expected = await contractRoutes();
  const order = (a: { operationId: string }, b: { operationId: string }) =>
    a.operationId.localeCompare(b.operationId);
  expect([...contractMinimumVersionRoutes()].sort(order)).toEqual(expected.sort(order));
});

it('[AC-B1-03c#6] 所有 true 写操作拦截；false 例外与 GET 放行', async () => {
  const f = fixture();
  const routes = (await contractRoutes()).filter((route) => route.path.startsWith('/v1/'));
  expect(routes.some((route) => route.gate === true)).toBe(true);
  expect(routes.some((route) => route.gate === false)).toBe(true);
  for (const route of routes) {
    if (route.gate === true) await expectBlocked(() => f.check(forRoute(route)), '2.10.3');
    else if (route.gate === false || route.method === 'GET') {
      await expect(f.check(forRoute(route))).resolves.toBeUndefined();
    }
  }
});

for (const [index, vector] of CONDITIONAL.entries()) {
  for (const scope of ['full', 'deletion_only'] as const) {
    it(`[AC-B1-03c#7] conditional ${index} ${vector.path} ${scope}：${JSON.stringify(vector.body)}`, async () => {
      const f = fixture();
      const input = request({
        routeOptions: { url: vector.path },
        body: vector.body,
        principal: { ...PRINCIPAL, scp: scope },
      });
      if (vector.allowed) await expect(f.check(input)).resolves.toBeUndefined();
      else await expectBlocked(() => f.check(input), '2.10.3');
      // Scope restrictions remain even after upgrading; gate exceptions are body-sensitive.
      if (scope === 'deletion_only' && !vector.allowed) {
        await expectBlocked(
          () => f.check({ ...input, headers: { ...HEADERS, 'x-app-version': '99.0.0' } }),
          '2.10.3',
        );
      }
    });
  }
}

it('[AC-B1-03c#8] deletion_only 严格遵守全部 x-session-scopes，表外 GET 也拒绝', async () => {
  const f = fixture();
  const routes = (await contractRoutes()).filter(
    (route) => route.path.startsWith('/v1/') && route.gate !== 'conditional',
  );
  for (const route of routes) {
    const input = {
      ...forRoute(route),
      principal: { ...PRINCIPAL, scp: 'deletion_only' as const },
      headers: { ...HEADERS, 'x-app-version': '99.0.0' },
    };
    if (route.sessionScopes.includes('deletion_only'))
      await expect(f.check(input)).resolves.toBeUndefined();
    else await expectBlocked(() => f.check(input), '2.10.3');
  }
  expect(
    routes.some(
      (route) => route.method === 'GET' && !route.sessionScopes.includes('deletion_only'),
    ),
  ).toBe(true);
});

for (const platform of ['ios', 'android', 'harmony', 'h5', 'admin']) {
  it(`[AC-B1-03c#9] ${platform} 无最低版本仍拒绝受限会话越权，data 最低版本为 null`, async () => {
    const f = fixture(null);
    await expectBlocked(
      () =>
        f.check(
          request({
            method: 'GET',
            routeOptions: { url: '/v1/orders' },
            principal: { ...PRINCIPAL, scp: 'deletion_only' },
            headers: { ...HEADERS, 'x-platform': platform, 'x-app-version': '99.0.0' },
          }),
        ),
      null,
    );
  });
}

it('[AC-B1-03c#10] 匿名 conditional 接口按头部 app 与端渠道判定，不需要 principal', async () => {
  const f = fixture();
  const input = request({ routeOptions: { url: '/v1/auth/sms-codes' }, body: { purpose: 'bind' } });
  const { principal, ...anonymous } = input;
  void principal;
  await expectBlocked(() => f.check(anonymous), '2.10.3');
  expect(f.read).toHaveBeenCalledWith('couli', 'ios', 'app_store');
});
