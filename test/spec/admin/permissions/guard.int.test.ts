import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type {
  AdminBusinessResponse,
  AdminPermissionPrincipal,
  AdminPermissionRequest,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { fixture, useHarness } from '../auth/kit.ts';
import { redisOf } from '../step-up/kit.ts';
import { adminSurface, expectedCatalog } from './expected.ts';

const h = useHarness();
const SUCCESS: AdminBusinessResponse = {
  statusCode: 200,
  body: { code: 0, data: { applied: true } },
};

async function setup() {
  const f = await fixture(h);
  const surface = await adminSurface();
  const deps = { clock: f.clock, redis: (await redisOf(f)).namespace('admin-step-up') };
  const guard = surface.createAdminPermissionGuard(deps);
  const tokens = surface.createAdminStepUpTokens(deps);
  const principal: AdminPermissionPrincipal = {
    appId: 'couli',
    adminId: randomUUID(),
    sessionId: randomUUID(),
    isSuper: false,
    hasVerifyPhone: true,
    permissions: [
      'fund.adjust',
      'fund.writeoff',
      'pii.reveal_phone',
      'fund.recon',
      'content.app_version',
      'user.list',
    ],
  };
  const request = (
    permission = 'fund.adjust',
    token?: string,
    patch: Partial<AdminPermissionRequest> = {},
  ): AdminPermissionRequest => ({
    principal,
    permission,
    headers: token === undefined ? {} : { 'x-step-up-token': token },
    ...patch,
  });
  const issue = (tier: 'sms' | 'totp' = 'sms', patch: Partial<AdminPermissionPrincipal> = {}) =>
    tokens.issue({ ...principal, ...patch, tier });
  return { f, surface, deps, guard, tokens, principal, request, issue };
}

export async function rejected(promise: Promise<unknown>, code: number, data: object) {
  await promise.then(
    () => expect.unreachable('守卫应拒绝而非执行操作'),
    (error: unknown) => {
      expect(error).toMatchObject({
        getStatus: expect.any(Function),
        getResponse: expect.any(Function),
      });
      const http = error as { getStatus(): number; getResponse(): { code: number; data: unknown } };
      expect(http.getStatus()).toBe(403);
      expect(http.getResponse()).toMatchObject({ code, data });
      expect(http.getResponse().data).toEqual(data);
    },
  );
}

it('[AC-F1-06l#21] 权限优先：未勾选权限返回 10403，即使有正确档位令牌也不能执行或核销', async () => {
  const s = await setup();
  const grant = await s.issue();
  const business = vi.fn(async () => SUCCESS);
  for (const token of [undefined, grant.step_up_token]) {
    await rejected(
      s.guard.run(
        s.request('fund.adjust', token, {
          principal: { ...s.principal, permissions: [] },
        }),
        business,
      ),
      10403,
      { reason: 'admin_permission_denied' },
    );
  }
  expect(business).not.toHaveBeenCalled();
  expect(await s.guard.run(s.request('fund.adjust', grant.step_up_token), business)).toEqual(
    SUCCESS,
  );
  expect(business).toHaveBeenCalledTimes(1);
}, 30_000);

it('[AC-F1-06l#22] 逐个权限与操作例外要求裁定档位，普通权限无需令牌', async () => {
  const s = await setup();
  for (const rule of expectedCatalog()) {
    const principal = { ...s.principal, permissions: [rule.key] };
    const business = vi.fn(async () => SUCCESS);
    const request = s.request(rule.key, undefined, { principal });
    if (rule.step_up_tier === null) {
      expect(await s.guard.run(request, business)).toEqual(SUCCESS);
      expect(business).toHaveBeenCalledTimes(1);
    } else {
      await rejected(s.guard.run(request, business), 10003, { tier: rule.step_up_tier });
      expect(business).not.toHaveBeenCalled();
    }
    for (const operation of rule.operations) {
      const callback = vi.fn(async () => SUCCESS);
      await rejected(s.guard.run({ ...request, operation: operation.operation }, callback), 10003, {
        tier: operation.tier,
      });
      expect(callback).not.toHaveBeenCalled();
      const grant = await s.issue(operation.tier);
      expect(
        await s.guard.run(
          {
            ...request,
            operation: operation.operation,
            headers: { 'x-step-up-token': grant.step_up_token },
          },
          callback,
        ),
      ).toEqual(SUCCESS);
    }
  }
}, 30_000);

it.each(['sms', 'totp'] as const)(
  '[AC-F1-06l#23] 超管有全部权限但仍需要 %s 档令牌',
  async (tier) => {
    const s = await setup();
    const permission = tier === 'sms' ? 'fund.adjust' : 'pii.reveal_phone';
    const principal = { ...s.principal, isSuper: true, permissions: [] };
    const business = vi.fn(async () => SUCCESS);
    await rejected(s.guard.run(s.request(permission, undefined, { principal }), business), 10003, {
      tier,
    });
    expect(business).not.toHaveBeenCalled();
    const grant = await s.issue(tier);
    expect(
      await s.guard.run(s.request(permission, grant.step_up_token, { principal }), business),
    ).toEqual(SUCCESS);
  },
  30_000,
);

it.each([false, true])(
  '[AC-F1-06l#24] 短信档未登记手机号明确提示；超管=%s 也不例外',
  async (isSuper) => {
    const s = await setup();
    const grant = await s.issue();
    const business = vi.fn(async () => SUCCESS);
    for (const token of [undefined, grant.step_up_token]) {
      await rejected(
        s.guard.run(
          s.request('fund.adjust', token, {
            principal: { ...s.principal, isSuper, hasVerifyPhone: false },
          }),
          business,
        ),
        10003,
        { tier: 'sms', reason: 'verify_phone_missing' },
      );
    }
    expect(business).not.toHaveBeenCalled();
    expect(await s.guard.run(s.request('fund.adjust', grant.step_up_token), business)).toEqual(
      SUCCESS,
    );
  },
  30_000,
);

it.each([
  'missing',
  'unknown',
  'expired',
  'admin',
  'session',
  'app',
  'totp-for-sms',
  'sms-for-totp',
] as const)(
  '[AC-F1-06l#25] 令牌无效场景 %s 返回所需档位且不调用业务',
  async (scenario) => {
    const s = await setup();
    const binding =
      scenario === 'admin'
        ? { adminId: randomUUID() }
        : scenario === 'session'
          ? { sessionId: randomUUID() }
          : scenario === 'app'
            ? { appId: 'other' }
            : {};
    const grant = await s.issue(scenario === 'totp-for-sms' ? 'totp' : 'sms', binding);
    if (scenario === 'expired') s.f.clock.advanceMs(300_000);
    const token =
      scenario === 'missing'
        ? undefined
        : scenario === 'unknown'
          ? randomBytes(32).toString('base64url')
          : grant.step_up_token;
    const permission = scenario === 'sms-for-totp' ? 'pii.reveal_phone' : 'fund.adjust';
    const business = vi.fn(async () => SUCCESS);
    await rejected(s.guard.run(s.request(permission, token), business), 10003, {
      tier: scenario === 'sms-for-totp' ? 'totp' : 'sms',
    });
    expect(business).not.toHaveBeenCalled();
  },
  30_000,
);

it.each([200, 201, 299])(
  '[AC-F1-06l#26] HTTP %s 且 code=0 成功后核销；另一守卫实例也不能重用',
  async (statusCode) => {
    const s = await setup();
    const grant = await s.issue();
    s.f.clock.advanceMs(299_999);
    const business = vi.fn(async () => ({ ...SUCCESS, statusCode }));
    expect(await s.guard.run(s.request('fund.adjust', grant.step_up_token), business)).toEqual({
      ...SUCCESS,
      statusCode,
    });
    const another = s.surface.createAdminPermissionGuard(s.deps);
    await rejected(another.run(s.request('fund.adjust', grant.step_up_token), business), 10003, {
      tier: 'sms',
    });
    expect(business).toHaveBeenCalledTimes(1);
  },
  30_000,
);

it.each([
  [200, 20001],
  [200, 50001],
  [400, 0],
  [500, 0],
  [302, 0],
  [199, 0],
])(
  '[AC-F1-06l#27] HTTP %s / code %s 不核销，有效期内可重试',
  async (statusCode, code) => {
    const s = await setup();
    const grant = await s.issue();
    const request = s.request('fund.adjust', grant.step_up_token);
    const result = { statusCode, body: { code } };
    expect(await s.guard.run(request, async () => result)).toEqual(result);
    expect(await s.guard.run(request, async () => SUCCESS)).toEqual(SUCCESS);
    await rejected(
      s.guard.run(request, async () => SUCCESS),
      10003,
      { tier: 'sms' },
    );
  },
  30_000,
);

it('[AC-F1-06l#28] 业务抛错不核销；无需 step-up 的查询也不消耗所带令牌', async () => {
  const s = await setup();
  const grant = await s.issue();
  const request = s.request('fund.adjust', grant.step_up_token);
  const failure = new Error('synthetic business failure');
  await expect(
    s.guard.run(request, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(
    await s.guard.run(s.request('user.list', grant.step_up_token), async () => SUCCESS),
  ).toEqual(SUCCESS);
  expect(await s.guard.run(request, async () => SUCCESS)).toEqual(SUCCESS);
}, 30_000);

it('[AC-F1-06l#29] 同一令牌并发请求至多一次成功，不产生两次业务操作', async () => {
  const s = await setup();
  const grant = await s.issue();
  const other = s.surface.createAdminPermissionGuard(s.deps);
  const business = vi.fn(async () => SUCCESS);
  const request = s.request('fund.adjust', grant.step_up_token);
  const outcomes = await Promise.allSettled([
    s.guard.run(request, business),
    other.run(request, business),
  ]);
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(business).toHaveBeenCalledTimes(1);
  const failed = outcomes.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  await rejected(Promise.reject(failed.reason), 10003, { tier: 'sms' });
}, 30_000);

it.each([false, true])(
  '[AC-F1-06l#35] 动态码档未登记手机号只提示 tier=totp，不带 reason；超管=%s',
  async (isSuper) => {
    const s = await setup();
    const principal = { ...s.principal, isSuper, hasVerifyPhone: false };
    const business = vi.fn(async () => SUCCESS);
    await rejected(
      s.guard.run(s.request('pii.reveal_phone', undefined, { principal }), business),
      10003,
      { tier: 'totp' },
    );
    expect(business).not.toHaveBeenCalled();
    const grant = await s.issue('totp');
    expect(
      await s.guard.run(
        s.request('pii.reveal_phone', grant.step_up_token, { principal }),
        business,
      ),
    ).toEqual(SUCCESS);
  },
  30_000,
);
