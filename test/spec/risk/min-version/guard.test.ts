import { expect, it, vi } from 'vitest';
import { createMinimumVersionGuard } from '../../../../apps/api/src/modules/risk/index.ts';
import { PRINCIPAL, contractRoutes, expectBlocked, fixture, forRoute, request } from './kit.ts';

it('[AC-B1-03c#18] 非幂等路由由 guard 直接检查，读取 ② 注入的 principal', async () => {
  const f = fixture(null);
  const input = request({
    method: 'GET',
    routeOptions: { url: '/v1/orders' },
    principal: { ...PRINCIPAL, scp: 'deletion_only' },
  });
  const guard = createMinimumVersionGuard(f.check);
  await expectBlocked(
    () => guard.canActivate({ switchToHttp: () => ({ getRequest: () => input }) }),
    null,
  );
});

it('[AC-B1-03c#19] 每个幂等契约操作的 guard 都延迟 ④a，不能抢在回放之前检查', async () => {
  const check = vi.fn(async () => {
    throw new Error('must defer to idempotency');
  });
  const guard = createMinimumVersionGuard(check);
  const routes = (await contractRoutes()).filter(
    (route) => route.idempotent && route.path.startsWith('/v1/'),
  );
  expect(routes.length).toBeGreaterThan(0);
  for (const route of routes) {
    const input = {
      ...forRoute(route),
      principal: { ...PRINCIPAL, scp: 'deletion_only' as const },
    };
    await expect(
      guard.canActivate({ switchToHttp: () => ({ getRequest: () => input }) }),
    ).resolves.toBe(true);
  }
  expect(check).not.toHaveBeenCalled();
});

it('[AC-B1-03c#20] 非幂等 conditional guard 使用解析后的请求体，拒绝后不执行 handler', async () => {
  const f = fixture();
  const guard = createMinimumVersionGuard(f.check);
  const input = request({
    routeOptions: { url: '/v1/consents' },
    body: { type: 'personalization', accepted: true },
  });
  const handler = vi.fn();
  await expectBlocked(async () => {
    await guard.canActivate({ switchToHttp: () => ({ getRequest: () => input }) });
    handler();
  }, '2.10.3');
  expect(handler).not.toHaveBeenCalled();
  await expect(
    guard.canActivate({
      switchToHttp: () => ({
        getRequest: () => ({ ...input, body: { type: 'personalization', accepted: false } }),
      }),
    }),
  ).resolves.toBe(true);
});
