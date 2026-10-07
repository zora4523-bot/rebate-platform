// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  createAuthProvider,
  type AdminAuthProvider,
} from '../../../../apps/admin/src/providers/auth/index.ts';
import {
  createDataProvider,
  AdminApiError,
} from '../../../../apps/admin/src/providers/data/index.ts';
import {
  CREDENTIALS,
  ME,
  NOW,
  SECRET,
  SESSION,
  harness,
  ok,
  rejected,
  signIn,
  stepData,
} from './fixtures.ts';

const providers: AdminAuthProvider[] = [];
function track(provider: AdminAuthProvider) {
  providers.push(provider);
  return provider;
}
afterEach(() => {
  for (const provider of providers.splice(0)) provider.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
  sessionStorage.clear();
});

for (const next of ['totp', 'change_password', 'bind_totp'] as const) {
  it(`[AC-F1-06h-AUTH#1] 密码通过后 next=${next} 只有中间状态，没有后台会话`, async () => {
    const h = harness(next);
    const auth = track(h.create());
    expect(await auth.check()).toMatchObject({ authenticated: false, redirectTo: '/login' });
    const result = await auth.login(CREDENTIALS);
    expect(result.redirectTo).toBeUndefined();
    expect(auth.getSnapshot()).toMatchObject({ step: next, username: 'ops-yi' });
    expect(auth.getToken()).toBeNull();
    expect(h.storage.setItem).not.toHaveBeenCalled();
    expect(await auth.check()).toMatchObject({ authenticated: false });
    expect(h.requests[0]).toEqual({
      path: '/admin/v1/auth/login',
      method: 'POST',
      body: { username: 'ops-yi', password: 'example-password' },
      authorization: null,
    });
    expect(h.requests.some((r) => r.path === '/admin/v1/me/permissions')).toBe(false);
    expect(h.requests.some((r) => r.path === '/admin/v1/auth/totp/secret')).toBe(
      next === 'bind_totp',
    );
  });
}

it('[AC-F1-06h-AUTH#2] 首次先改密、用新 ticket 取密钥，绑定成功才签入', async () => {
  const h = harness('change_password');
  const auth = track(h.create());
  await auth.login(CREDENTIALS);
  await auth.login({ step: 'change_password', newPassword: 'example-new-password' });
  expect(auth.getSnapshot()).toMatchObject({ step: 'bind_totp', secret: SECRET });
  expect(auth.getToken()).toBeNull();
  expect(h.storage.values.size).toBe(0);
  expect(h.requests.map((r) => [r.path, r.body])).toEqual([
    ['/admin/v1/auth/login', { username: 'ops-yi', password: 'example-password' }],
    [
      '/admin/v1/auth/password',
      { login_ticket: 'example-login-ticket-password', new_password: 'example-new-password' },
    ],
    ['/admin/v1/auth/totp/secret', { login_ticket: 'example-login-ticket-bind' }],
  ]);
  const result = await auth.login({ step: 'bind_totp', code: '123456' });
  expect(result.success).toBe(true);
  expect(auth.getSnapshot().step).toBe('done');
  expect(auth.getSnapshot().secret).toBeUndefined();
  expect(auth.getToken()).toBe(SESSION.admin_token);
  expect(h.requests.find((r) => r.path.endsWith('/totp/bind'))).toMatchObject({
    method: 'POST',
    body: { login_ticket: 'example-login-ticket-bind', code: '123456' },
    authorization: null,
  });
  expect(await auth.check()).toMatchObject({ authenticated: true });
});

it('[AC-F1-06h-AUTH#3] 已绑定账号经 totp 直登，身份来自 me，data provider 实际携带 Bearer', async () => {
  const h = harness();
  const auth = track(h.create());
  await signIn(auth);
  expect(await auth.getIdentity()).toEqual(ME);
  expect(h.requests.find((r) => r.path.endsWith('/auth/totp'))).toMatchObject({
    body: { login_ticket: 'example-login-ticket-totp', code: '123456' },
  });
  const data = createDataProvider({
    ...h.options.api,
    getToken: () => auth.getToken(),
    onError: () => undefined,
  });
  await data.custom!({ url: '/admin/v1/me/permissions', method: 'get' });
  expect(
    h.requests
      .filter((r) => r.path.endsWith('/me/permissions'))
      .every((r) => r.authorization === 'Bearer example-admin-token'),
  ).toBe(true);
  expect(
    h.requests.some((r) => r.path.endsWith('/totp/bind') || r.path.endsWith('/totp/secret')),
  ).toBe(false);
});

for (const step of ['totp', 'bind_totp'] as const) {
  it(`[AC-F1-06h-AUTH#4] ${step} 错码不登录不绑定，同一 ticket 可重试`, async () => {
    const h = harness(step);
    const path = step === 'totp' ? '/admin/v1/auth/totp' : '/admin/v1/auth/totp/bind';
    h.queue(path, () =>
      rejected(20002, { reason: step === 'totp' ? 'totp_invalid' : 'totp_bind_invalid' }),
    );
    const auth = track(h.create());
    await auth.login(CREDENTIALS);
    expect((await auth.login({ step, code: '000000' })).success).toBe(false);
    expect(auth.getSnapshot().step).toBe(step);
    expect(auth.getToken()).toBeNull();
    expect(h.storage.setItem).not.toHaveBeenCalled();
    expect(await auth.check()).toMatchObject({ authenticated: false });
    expect((await auth.login({ step, code: '123456' })).success).toBe(true);
    expect(h.requests.filter((r) => r.path === path).map((r) => r.body)).toEqual([
      { login_ticket: stepData(step).login_ticket, code: '000000' },
      { login_ticket: stepData(step).login_ticket, code: '123456' },
    ]);
  });
}

for (const next of ['totp', 'bind_totp', 'change_password'] as const) {
  it(`[AC-F1-06h-AUTH#5] ${next} 凭证过期丢弃中间状态回第一步`, async () => {
    const h = harness(next);
    const path =
      next === 'totp'
        ? '/admin/v1/auth/totp'
        : next === 'bind_totp'
          ? '/admin/v1/auth/totp/bind'
          : '/admin/v1/auth/password';
    h.queue(path, () => rejected(10001, { reason: 'login_ticket_expired' }));
    const auth = track(h.create());
    await auth.login(CREDENTIALS);
    await auth.login(
      next === 'change_password'
        ? { step: next, newPassword: 'example-new-password' }
        : { step: next, code: '123456' },
    );
    expect(auth.getSnapshot()).toMatchObject({
      step: 'credentials',
      error: { key: 'error.10001.login_ticket_expired' },
    });
    expect(auth.getSnapshot().secret).toBeUndefined();
    expect(auth.getToken()).toBeNull();
    expect(h.storage.values.size).toBe(0);
  });
}

it('[AC-F1-06h-AUTH#6] 离开绑定页丢弃密钥和 ticket；重登只能用新 ticket', async () => {
  const h = harness('bind_totp');
  const auth = track(h.create());
  await auth.login(CREDENTIALS);
  auth.resetLogin();
  expect(auth.getSnapshot()).toMatchObject({ step: 'credentials' });
  expect(auth.getSnapshot().secret).toBeUndefined();
  expect(h.storage.values.size).toBe(0);
  h.queue('/admin/v1/auth/login', () =>
    ok({ ...stepData('bind_totp'), login_ticket: 'replacement-ticket' }),
  );
  h.queue('/admin/v1/auth/totp/secret', () => ok({ ...SECRET, totp_secret: 'ABCDEFGHIJKLMNOP' }));
  await auth.login(CREDENTIALS);
  expect(h.requests.filter((r) => r.path.endsWith('/totp/secret')).at(-1)?.body).toEqual({
    login_ticket: 'replacement-ticket',
  });
  expect(auth.getSnapshot().secret?.totp_secret).toBe('ABCDEFGHIJKLMNOP');
});

it('[AC-F1-06h-AUTH#7] 退出途中返回的旧密钥响应不能恢复已离开的绑定页', async () => {
  const h = harness('bind_totp');
  let release!: (value: Response) => void;
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.queue('/admin/v1/auth/totp/secret', () => {
    entered();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const auth = track(h.create());
  const pending = auth.login(CREDENTIALS);
  await arrived;
  auth.resetLogin();
  release(ok(SECRET));
  await pending;
  expect(auth.getSnapshot().step).toBe('credentials');
  expect(auth.getSnapshot().secret).toBeUndefined();
  expect(auth.getToken()).toBeNull();
});

it('[AC-F1-06h-AUTH#8] storage 只持久化会话，不留密码、ticket、动态码或绑定密钥', async () => {
  const h = harness('bind_totp');
  const auth = track(h.create());
  const read = vi.spyOn(Storage.prototype, 'getItem');
  const write = vi.spyOn(Storage.prototype, 'setItem');
  await auth.login(CREDENTIALS);
  await auth.login({ step: 'bind_totp', code: '123456' });
  const stored = [...h.storage.values.values()].join(' ');
  expect(stored).toContain(SESSION.admin_token);
  for (const sensitive of [
    'example-password',
    'example-login-ticket',
    '123456',
    SECRET.totp_secret,
    'otpauth://',
  ])
    expect(stored).not.toContain(sensitive);
  await auth.logout({});
  expect([...h.storage.values.values()].join(' ')).not.toContain(SESSION.admin_token);
  expect(read.mock.contexts).not.toContain(localStorage);
  expect(write.mock.contexts).not.toContain(localStorage);
});

it('[AC-F1-06h-AUTH#9] 默认 storage 仅 sessionStorage，页面刷新恢复但不重置空闲时刻', async () => {
  const h = harness();
  const read = vi.spyOn(Storage.prototype, 'getItem');
  const write = vi.spyOn(Storage.prototype, 'setItem');
  const auth = track(createAuthProvider({ api: h.options.api, clock: h.options.clock }));
  await signIn(auth);
  expect(Object.values(sessionStorage).join(' ')).toContain(SESSION.admin_token);
  h.setNow(NOW + 29 * 60_000);
  const restored = track(createAuthProvider({ api: h.options.api, clock: h.options.clock }));
  expect(restored.getToken()).toBe(SESSION.admin_token);
  h.setNow(NOW + 30 * 60_000);
  expect(await restored.check()).toMatchObject({ authenticated: false, redirectTo: '/login' });
  expect(restored.getToken()).toBeNull();
  expect(Object.values(sessionStorage).join(' ')).not.toContain(SESSION.admin_token);
  expect(read.mock.contexts).not.toContain(localStorage);
  expect(write.mock.contexts).not.toContain(localStorage);
});

it('[AC-F1-06h-AUTH#10] 空闲边界 30 分钟，成功请求延长空闲期，check 本身不延长', async () => {
  const h = harness();
  const auth = track(h.create());
  await signIn(auth);
  h.setNow(NOW + 20 * 60_000);
  auth.recordSuccessfulRequest();
  h.setNow(NOW + 50 * 60_000 - 1);
  expect(await auth.check()).toMatchObject({ authenticated: true });
  h.setNow(NOW + 50 * 60_000);
  expect(await auth.check()).toMatchObject({ authenticated: false, redirectTo: '/login' });
  expect(auth.getToken()).toBeNull();
  expect([...h.storage.values.values()].join(' ')).not.toContain(SESSION.admin_token);
});

it('[AC-F1-06h-AUTH#11] 持续成功请求不能延长服务器的 8 小时绝对有效期', async () => {
  const h = harness();
  const auth = track(h.create());
  await signIn(auth);
  for (let minute = 20; minute < 480; minute += 20) {
    h.setNow(NOW + minute * 60_000);
    auth.recordSuccessfulRequest();
  }
  h.setNow(Date.parse(SESSION.expires_at) - 1);
  expect(await auth.check()).toMatchObject({ authenticated: true });
  h.setNow(Date.parse(SESSION.expires_at));
  expect(await auth.check()).toMatchObject({ authenticated: false, redirectTo: '/login' });
  expect(auth.getToken()).toBeNull();
});

it('[AC-F1-06h-AUTH#12] 任意接口 10001 无 reason 退出；10403 与网络错误不退出也不刷新空闲期', async () => {
  const h = harness();
  const auth = track(h.create());
  await signIn(auth);
  for (const code of [10403, -1]) {
    h.setNow(NOW + 29 * 60_000);
    const response = await auth.onError(
      new AdminApiError({
        code,
        msg: 'error',
        data: undefined,
        httpStatus: code === -1 ? 0 : 403,
        kind: code === -1 ? 'network' : 'api',
      }),
    );
    expect(response.logout).not.toBe(true);
    expect(auth.getToken()).toBe(SESSION.admin_token);
  }
  h.setNow(NOW + 30 * 60_000);
  expect(await auth.check()).toMatchObject({ authenticated: false });
  h.setNow(NOW);
  await signIn(auth);
  expect(
    await auth.onError(
      new AdminApiError({
        code: 10001,
        msg: '请先登录',
        data: undefined,
        httpStatus: 401,
        kind: 'api',
      }),
    ),
  ).toMatchObject({ logout: true, redirectTo: '/login' });
  expect(auth.getToken()).toBeNull();
  expect(await auth.getIdentity()).toBeNull();
});

it('[AC-F1-06h-AUTH#13] logout 调用服务端撤销并清会话，即使服务端已过期', async () => {
  const h = harness();
  const auth = track(h.create());
  await signIn(auth);
  h.queue('/admin/v1/auth/logout', () => rejected(10001));
  expect(await auth.logout({})).toMatchObject({ success: true, redirectTo: '/login' });
  expect(h.requests.at(-1)).toMatchObject({
    path: '/admin/v1/auth/logout',
    method: 'POST',
    authorization: 'Bearer example-admin-token',
  });
  expect(auth.getToken()).toBeNull();
  expect(await auth.getIdentity()).toBeNull();
  expect([...h.storage.values.values()].join(' ')).not.toContain(SESSION.admin_token);
});

it('[AC-F1-06h-AUTH#14] 离开绑定页后才到达的验证响应不能恢复本地登录', async () => {
  const h = harness('bind_totp');
  let release!: (value: Response) => void;
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.queue('/admin/v1/auth/totp/bind', () => {
    entered();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const auth = track(h.create());
  await auth.login(CREDENTIALS);
  const pending = auth.login({ step: 'bind_totp', code: '123456' });
  await arrived;
  auth.resetLogin();
  release(ok(SESSION));
  await pending;
  expect(auth.getSnapshot().step).toBe('credentials');
  expect(auth.getToken()).toBeNull();
  expect(h.storage.setItem).not.toHaveBeenCalled();
  expect(h.requests.some((request) => request.path.endsWith('/me/permissions'))).toBe(false);
});
