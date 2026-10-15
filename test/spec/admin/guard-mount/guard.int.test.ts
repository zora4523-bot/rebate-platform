import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import * as redisModule from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { signedIn, useHarness } from '../auth/kit.ts';
import { allowed, PROBE, rejected, setup, TRACE } from './kit.ts';

const h = useHarness();

it('[AC-F1-06u#2] 未勾权限优先返回 10403，不执行业务也不核销所带令牌', async () => {
  const s = await setup(h, { permission: 'pii.reveal_phone', grants: [] });
  const token = (await s.issue()).step_up_token;
  for (const value of [undefined, token]) {
    await rejected(await s.read(value), 10403, { reason: 'admin_permission_denied' });
  }
  expect(s.business).not.toHaveBeenCalled();
  await s.grant('pii.reveal_phone');
  allowed(await s.read(token), {
    adminId: s.a.id,
    appId: 'couli',
    isSuper: false,
    loginName: s.a.username,
  });
  expect(s.business).toHaveBeenCalledTimes(1);
});

it('[AC-F1-06u#3] 使用已验证身份与账号表登录名，忽略客户端伪造身份', async () => {
  const s = await setup(h);
  const loginName = s.a.username;
  const response = await s.read(undefined, {
    'x-admin-id': randomUUID(),
    'x-app-id': 'forged',
    'x-is-super': 'true',
    'x-login-name': 'forged',
  });
  const actor = { adminId: s.a.id, appId: 'couli', isSuper: false, loginName };
  allowed(response, actor);
  expect(s.business).toHaveBeenCalledExactlyOnceWith(actor);
  expect(s.requests[0]?.adminPrincipal).toMatchObject({
    adminId: s.a.id,
    appId: 'couli',
    isSuper: false,
  });
  expect(s.requests[0]?.adminPrincipal?.sessionId).toEqual(expect.any(String));
});

it('[AC-F1-06u#4] 超管未勾任何点也能执行，但不能绕过二次验证', async () => {
  const s = await setup(h, { isSuper: true, grants: [] });
  allowed(await s.read(), {
    adminId: s.a.id,
    appId: 'couli',
    isSuper: true,
    loginName: s.a.username,
  });
  s.selection.permission = 'pii.reveal_phone';
  await rejected(await s.read(), 10003, { tier: 'totp' });
  expect(s.business).toHaveBeenCalledTimes(1);
});

it('[AC-F1-06u#5] totp 权限缺少令牌时按实际请求 trace_id 返回 10003', async () => {
  const s = await setup(h, { permission: 'pii.reveal_phone' });
  await rejected(await s.read(), 10003, { tier: 'totp' });
  expect(s.business).not.toHaveBeenCalled();
});

it.each(['totp', 'sms'] as const)(
  '[AC-F1-06u#6] HTTP 签发的 %s 令牌可执行一次成功业务，成功后不能重用',
  async (tier) => {
    const s = await setup(h, {
      permission: tier === 'totp' ? 'pii.reveal_phone' : 'fund.adjust',
      phone: true,
    });
    const token = (await s.issue(tier)).step_up_token;
    const actor = { adminId: s.a.id, appId: 'couli', isSuper: false, loginName: s.a.username };
    allowed(await s.read(token), actor);
    await rejected(await s.read(token), 10003, { tier });
    expect(s.business).toHaveBeenCalledExactlyOnceWith(actor);
  },
);

it('[AC-F1-06u#7] null 档忽略无效令牌，也不核销所带有效令牌', async () => {
  const create = redisModule.createRedisHandle;
  const touched = vi.fn();
  // Observe the real Redis seam from construction, including namespaces cached by providers.
  const factory = vi.spyOn(redisModule, 'createRedisHandle').mockImplementation(async (...args) => {
    const handle = await create(...args);
    if (handle === null) return null;
    return {
      namespace(name) {
        const namespace = handle.namespace(name);
        if (name !== 'admin-step-up') return namespace;
        return {
          get(key) {
            touched('get');
            return namespace.get(key);
          },
          set(key, value, ttl) {
            touched('set');
            return namespace.set(key, value, ttl);
          },
          eval(script, options) {
            touched('eval');
            return namespace.eval(script, options);
          },
        };
      },
      close: () => handle.close(),
      onApplicationShutdown: () => handle.onApplicationShutdown(),
    };
  });
  try {
    const s = await setup(h, { grants: ['content.platform_icon', 'pii.reveal_phone'] });
    const actor = { adminId: s.a.id, appId: 'couli', isSuper: false, loginName: s.a.username };
    touched.mockClear();
    allowed(await s.read('invalid-step-up-token'), actor);
    expect(touched).not.toHaveBeenCalled();
    const token = (await s.issue()).step_up_token;
    touched.mockClear();
    allowed(await s.read(token), actor);
    expect(touched).not.toHaveBeenCalled();
    s.selection.permission = 'pii.reveal_phone';
    allowed(await s.read(token), actor);
    expect(touched).toHaveBeenCalled();
    await rejected(await s.read(token), 10003, { tier: 'totp' });
    expect(s.business).toHaveBeenCalledTimes(3);
  } finally {
    factory.mockRestore();
  }
});

it.each([false, true])(
  '[AC-F1-06u#8] 短信档读取验证手机号登记状态，超管=%s 也不能省略',
  async (isSuper) => {
    const s = await setup(h, { permission: 'fund.adjust', isSuper });
    await rejected(await s.read(), 10003, { tier: 'sms', reason: 'verify_phone_missing' });
    expect(s.business).not.toHaveBeenCalled();
  },
);

it.each([
  ['content.app_version', 'content.app_version.raise_min_supported_version', 'totp'],
  ['fund.recon', 'fund.recon.balance_recalc', 'sms'],
] as const)('[AC-F1-06u#9] 传递操作 %s / %s 的例外档位 %s', async (permission, operation, tier) => {
  const s = await setup(h, { permission, operation, phone: true });
  await rejected(await s.read(), 10003, { tier });
  expect(s.business).not.toHaveBeenCalled();
  const token = (await s.issue(tier)).step_up_token;
  allowed(await s.read(token), {
    adminId: s.a.id,
    appId: 'couli',
    isSuper: false,
    loginName: s.a.username,
  });
});

it('[AC-F1-06u#10] 后台令牌检查通过后账号被停用，端口重新读取并拒绝', async () => {
  const s = await setup(h);
  s.hooks.beforeRun = async () => {
    await h.db
      .updateTable('admin_users')
      .set({ status: 'disabled' })
      .where('id', '=', s.a.id)
      .execute();
  };
  await rejected(await s.read(), 10001);
  expect(s.requests).toHaveLength(1);
  expect(s.requests[0]?.adminPrincipal?.adminId).toBe(s.a.id);
  expect(s.business).not.toHaveBeenCalled();
});

it('[AC-F1-06u#11] 每次重新读勾选权限，撤销权限后同一登录会话不能继续执行', async () => {
  const s = await setup(h);
  allowed(await s.read(), {
    adminId: s.a.id,
    appId: 'couli',
    isSuper: false,
    loginName: s.a.username,
  });
  await h.db.deleteFrom('admin_permissions').where('admin_id', '=', s.a.id).execute();
  await rejected(await s.read(), 10403, { reason: 'admin_permission_denied' });
  expect(s.business).toHaveBeenCalledTimes(1);
});

it('[AC-F1-06u#12] 缺少服务端后台身份是编程错误，即使携带合法 Authorization 也不自行补鉴权', async () => {
  const s = await setup(h);
  s.hooks.beforeRun = async (request) => {
    delete request.adminPrincipal;
  };
  await rejected(await s.read(), 50001);
  expect(s.requests).toHaveLength(1);
  expect(s.business).not.toHaveBeenCalled();
});

it.each(['missing', 'other-app'] as const)(
  '[AC-F1-06u#13] 身份对应账号 %s 时返回 10001，不能跨 app_id 读取账号',
  async (scenario) => {
    const s = await setup(h);
    s.hooks.beforeRun = async (request) => {
      expect(request.adminPrincipal).toBeDefined();
      request.adminPrincipal = {
        ...request.adminPrincipal!,
        ...(scenario === 'missing' ? { adminId: randomUUID() } : { appId: 'other-app' }),
      };
    };
    await rejected(await s.read(), 10001);
    expect(s.business).not.toHaveBeenCalled();
  },
);

it('[AC-F1-06u#14] 后台鉴权之后数据库读取失败，按请求返回 50001', async () => {
  const s = await setup(h);
  let restore: (() => void) | undefined;
  s.hooks.beforeRun = async () => {
    const spy = vi
      .spyOn(h.db.getExecutor(), 'executeQuery')
      .mockRejectedValue(new Error('profile database unavailable'));
    restore = () => spy.mockRestore();
  };
  try {
    await rejected(await s.read(), 50001);
    expect(s.requests).toHaveLength(1);
    expect(s.business).not.toHaveBeenCalled();
  } finally {
    restore?.();
  }
});

it('[AC-F1-06u#15] 后台鉴权之后 Redis 不可用，需 step-up 的请求不能执行', async () => {
  const s = await setup(h, { permission: 'pii.reveal_phone' });
  const token = (await s.issue()).step_up_token;
  s.hooks.beforeRun = async () => {
    await s.f.closeRedis();
  };
  await rejected(await s.read(token), 50001);
  expect(s.requests).toHaveLength(1);
  expect(s.business).not.toHaveBeenCalled();
});

it('[AC-F1-06u#16] 同账号的另一登录会话不能使用原会话签发的令牌，拒绝不核销', async () => {
  const s = await setup(h, { permission: 'pii.reveal_phone' });
  const token = (await s.issue()).step_up_token;
  s.f.clock.advanceMs(30_000);
  const other = await signedIn(s.f, s.a);
  await rejected(
    await s.f.read(other.admin_token, PROBE, { 'x-trace-id': TRACE, 'x-step-up-token': token }),
    10003,
    { tier: 'totp' },
  );
  expect(s.business).not.toHaveBeenCalled();
  allowed(await s.read(token), {
    adminId: s.a.id,
    appId: 'couli',
    isSuper: false,
    loginName: s.a.username,
  });
});

it.each([
  [200, 20001],
  [409, 0],
] as const)(
  '[AC-F1-06u#17] 原样传回业务 HTTP %s / code %s，失败响应不核销令牌',
  async (statusCode, code) => {
    const s = await setup(h, { permission: 'pii.reveal_phone' });
    const token = (await s.issue()).step_up_token;
    const result = { statusCode, body: { code, data: { rejected: true } } };
    s.business.mockResolvedValueOnce(result);
    const response = await s.read(token);
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual(result.body);
    allowed(await s.read(token), {
      adminId: s.a.id,
      appId: 'couli',
      isSuper: false,
      loginName: s.a.username,
    });
    await rejected(await s.read(token), 10003, { tier: 'totp' });
    expect(s.business).toHaveBeenCalledTimes(2);
  },
);

it('[AC-F1-06u#18] 业务抛错由全局错误处理返回 50001，令牌仍能用于一次成功业务', async () => {
  const s = await setup(h, { permission: 'pii.reveal_phone' });
  const token = (await s.issue()).step_up_token;
  s.business.mockRejectedValueOnce(new Error('synthetic business failure'));
  await rejected(await s.read(token), 50001);
  allowed(await s.read(token), {
    adminId: s.a.id,
    appId: 'couli',
    isSuper: false,
    loginName: s.a.username,
  });
  expect(s.business).toHaveBeenCalledTimes(2);
});
