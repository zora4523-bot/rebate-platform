import { randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { createAdminApi, type AdminApi } from '../../../../apps/admin/src/providers/admin-api.ts';
import type { AuthStorage } from '../../../../apps/admin/src/providers/auth/index.ts';
import { isLoginTextKey } from '../../../../apps/admin/src/texts/login.ts';
import {
  account,
  AUTH,
  fixture,
  NOW,
  ORIGIN,
  READ,
  row,
  SUPER,
  totp,
  useHarness,
  wrongCode,
  type Account,
  type Fixture,
  type Request as InjectRequest,
} from '../../admin/auth/kit.ts';

const h = useHarness();
const clients: AdminApi[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.auth.dispose();
});

interface Exchange {
  path: string;
  authorization: string | null;
  status: number;
  body: unknown;
}

function memoryStorage(): AuthStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

// All HTTP responses originate in the real admin entry; no response fixtures or browser globals.
function clientFor(f: Fixture, remoteAddress = '127.0.0.1') {
  const exchanges: Exchange[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe(ORIGIN);
    expect(['GET', 'POST', 'OPTIONS']).toContain(request.method);
    const payload = await request.text();
    const response = await f.app.inject({
      method: request.method as InjectRequest['method'],
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers),
      ...(payload === '' ? {} : { payload }),
      remoteAddress,
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
    }
    const body = response.json<unknown>();
    exchanges.push({
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.get('authorization'),
      status: response.statusCode,
      body,
    });
    return new Response(JSON.stringify(body), { status: response.statusCode, headers });
  };
  const api = createAdminApi({
    baseUrl: ORIGIN,
    fetch,
    storage: memoryStorage(),
    clock: { now: () => f.clock.now().getTime() },
    manualStart: true,
  });
  clients.push(api);
  return { api, exchanges };
}

async function credentials(api: AdminApi, a: Account): Promise<void> {
  expect(
    await api.auth.login({ step: 'credentials', username: a.username, password: a.password }),
  ).toMatchObject({ success: true });
  expect(api.auth.getToken()).toBeNull();
}

async function signIn(api: AdminApi, f: Fixture, a: Account): Promise<string> {
  await credentials(api, a);
  expect(api.auth.getSnapshot()).toMatchObject({ step: 'totp', username: a.username });
  expect(await api.auth.login({ step: 'totp', code: totp(a.secret, f.clock) })).toMatchObject({
    success: true,
  });
  expect(api.auth.getSnapshot()).toMatchObject({ step: 'done', username: a.username });
  const token = api.auth.getToken();
  expect(token).toEqual(expect.any(String));
  expect(token).not.toBe('');
  return token!;
}

function loginFailure(
  api: AdminApi,
  exchanges: Exchange[],
  path: string,
  status: number,
  code: number,
  reason?: string,
): void {
  const key = reason === undefined ? `error.${code}` : `error.${code}.${reason}`;
  expect(isLoginTextKey(key)).toBe(true);
  expect(api.auth.getSnapshot().error?.key).toBe(key);
  expect(api.auth.getToken()).toBeNull();
  expect(exchanges.at(-1)).toMatchObject({
    path: `${AUTH}${path}`,
    status,
    body: { code, ...(reason === undefined ? {} : { data: { reason } }) },
  });
}

it('[AC-F1-06zb#1] 已绑定超管经密码与动态码登录，权限快照及用户名与真实入口一致', async () => {
  const f = await fixture(h);
  const a = await account(h, { is_super: true });
  const { api, exchanges } = clientFor(f);
  const token = await signIn(api, f, a);
  const response = await f.read(token);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  const me = response.json<{ data: Schema<'AdminMe'> }>().data;
  const loaded = await api.loadPermissions();
  expect(loaded.username).toBe(a.username);
  expect(me.username).toBe(a.username);
  expect(loaded.snapshot).toEqual({
    isSuper: true,
    permissions: me.permissions.map((grant) => grant.key),
    stepUp: Object.fromEntries(
      me.permissions.map((grant) => [
        grant.key,
        {
          tier: grant.step_up_tier,
          operations: Object.fromEntries(
            grant.step_up_operations.map((op) => [op.operation, op.tier]),
          ),
        },
      ]),
    ),
  });
  expect(exchanges.filter((exchange) => exchange.path.startsWith(AUTH))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: `${AUTH}/login`, authorization: null, status: 200 }),
      expect.objectContaining({ path: `${AUTH}/totp`, authorization: null, status: 200 }),
    ]),
  );
  expect(exchanges.at(-1)).toMatchObject({ path: READ, authorization: `Bearer ${token}` });
}, 30_000);

it('[AC-F1-06zb#2] 首次登录先改密再取真实密钥绑定，完成前无令牌且服务端记录已绑定', async () => {
  const f = await fixture(h);
  const a = await account(h, {
    password_must_change: true,
    totp_secret_cipher: null,
    totp_bound_at: null,
  });
  const { api, exchanges } = clientFor(f);
  await credentials(api, a);
  expect(api.auth.getSnapshot().step).toBe('change_password');
  expect(
    await api.auth.login({
      step: 'change_password',
      newPassword: randomBytes(24).toString('base64url'),
    }),
  ).toMatchObject({ success: true });
  const snapshot = api.auth.getSnapshot();
  expect(snapshot.step).toBe('bind_totp');
  expect(snapshot.secret).toMatchObject({
    totp_secret: expect.any(String),
    otpauth_uri: expect.any(String),
  });
  expect(snapshot.secret?.totp_secret).toMatch(/^[A-Z2-7]+$/);
  expect(exchanges.at(-1)).toMatchObject({
    path: `${AUTH}/totp/secret`,
    status: 200,
    body: { code: 0, data: snapshot.secret },
  });
  expect(api.auth.getToken()).toBeNull();
  expect(await row(h, a)).toMatchObject({ password_must_change: false, totp_bound_at: null });
  expect(
    await api.auth.login({ step: 'bind_totp', code: totp(snapshot.secret!.totp_secret, f.clock) }),
  ).toMatchObject({ success: true });
  expect(api.auth.getSnapshot()).toMatchObject({ step: 'done', bound: true });
  expect(api.auth.getToken()).toEqual(expect.any(String));
  const bound = await row(h, a);
  expect(bound.totp_secret_cipher).not.toBeNull();
  expect(bound.totp_bound_at?.toISOString()).toBe(NOW);
  expect((await api.loadPermissions()).username).toBe(a.username);
}, 30_000);

it('[AC-F1-06zb#3] 密码错误 10008，连续错误锁定 10009，锁定截止时间原样交给登录页', async () => {
  const f = await fixture(h);
  const a = await account(h);
  const { api, exchanges } = clientFor(f);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    expect(
      await api.auth.login({
        step: 'credentials',
        username: a.username,
        password: `${a.password}-wrong`,
      }),
    ).toMatchObject({ success: false });
    loginFailure(api, exchanges, '/login', attempt < 5 ? 401 : 403, attempt < 5 ? 10008 : 10009);
  }
  const lockedUntil = (await row(h, a)).locked_until?.toISOString();
  expect(lockedUntil).toEqual(expect.any(String));
  expect(exchanges.at(-1)).toMatchObject({ body: { data: { locked_until: lockedUntil } } });
  expect(api.auth.getSnapshot()).toMatchObject({ step: 'credentials', error: { lockedUntil } });
}, 30_000);

it('[AC-F1-06zb#4] 真入口拒绝错误动态码，20002 totp_invalid 对应登录词典', async () => {
  const f = await fixture(h);
  const a = await account(h);
  const { api, exchanges } = clientFor(f);
  await credentials(api, a);
  expect(await api.auth.login({ step: 'totp', code: wrongCode(a.secret, f.clock) })).toMatchObject({
    success: false,
  });
  loginFailure(api, exchanges, '/totp', 400, 20002, 'totp_invalid');
  expect(api.auth.getSnapshot().step).toBe('totp');
}, 30_000);

it('[AC-F1-06zb#5] 登录票超过五分钟后交码，10001 login_ticket_expired 回到密码步骤', async () => {
  const f = await fixture(h);
  const a = await account(h);
  const { api, exchanges } = clientFor(f);
  await credentials(api, a);
  f.clock.advanceMs(300_001);
  expect(await api.auth.login({ step: 'totp', code: totp(a.secret, f.clock) })).toMatchObject({
    success: false,
  });
  loginFailure(api, exchanges, '/totp', 401, 10001, 'login_ticket_expired');
  expect(api.auth.getSnapshot().step).toBe('credentials');
}, 30_000);

it('[AC-F1-06zb#6] 绑定错误码 20002 totp_bind_invalid 保留绑定步骤且服务端未绑定', async () => {
  const f = await fixture(h);
  const a = await account(h, { totp_secret_cipher: null, totp_bound_at: null });
  const { api, exchanges } = clientFor(f);
  await credentials(api, a);
  const snapshot = api.auth.getSnapshot();
  expect(snapshot.step).toBe('bind_totp');
  expect(snapshot.secret?.totp_secret).toMatch(/^[A-Z2-7]+$/);
  expect(
    await api.auth.login({
      step: 'bind_totp',
      code: wrongCode(snapshot.secret!.totp_secret, f.clock),
    }),
  ).toMatchObject({ success: false });
  loginFailure(api, exchanges, '/totp/bind', 400, 20002, 'totp_bind_invalid');
  expect(api.auth.getSnapshot().step).toBe('bind_totp');
  expect((await row(h, a)).totp_bound_at).toBeNull();
}, 30_000);

it('[AC-F1-06zb#7] 非白名单 IP 的 10403 admin_ip_not_allowed 显示对应词典键', async () => {
  const f = await fixture(h);
  const a = await account(h);
  const { api, exchanges } = clientFor(f, '203.0.113.9');
  expect(
    await api.auth.login({ step: 'credentials', username: a.username, password: a.password }),
  ).toMatchObject({ success: false });
  loginFailure(api, exchanges, '/login', 403, 10403, 'admin_ip_not_allowed');
}, 30_000);

it('[AC-F1-06zb#8] 超管 data 列表携带当前令牌与分页参数，返回真实账号及 total', async () => {
  const f = await fixture(h);
  const a = await account(h, { is_super: true });
  const { api, exchanges } = clientFor(f);
  const token = await signIn(api, f, a);
  const list = await api.data.getList({
    resource: 'admins',
    pagination: { currentPage: 1, pageSize: 20 },
  });
  const response = await f.read(token, `${SUPER}?page=1&page_size=20`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  const page = response.json<{ data: Schema<'AdminAccountPage'> }>().data;
  expect(list).toEqual({ data: page.items, total: page.total });
  expect(list.data).toEqual(
    expect.arrayContaining([expect.objectContaining({ admin_id: a.id, username: a.username })]),
  );
  expect(exchanges.at(-1)).toMatchObject({
    path: `${SUPER}?page=1&page_size=20`,
    authorization: `Bearer ${token}`,
    status: 200,
  });
}, 30_000);

it('[AC-F1-06zb#9] 非超管读账号列表收到 10403 admin_permission_denied，但登录会话仍有效', async () => {
  const f = await fixture(h);
  const a = await account(h);
  const { api, exchanges } = clientFor(f);
  const token = await signIn(api, f, a);
  await expect(
    api.data.getList({ resource: 'admins', pagination: { currentPage: 1, pageSize: 20 } }),
  ).rejects.toMatchObject({
    kind: 'api',
    code: 10403,
    httpStatus: 403,
    data: { reason: 'admin_permission_denied' },
  });
  expect(exchanges.at(-1)).toMatchObject({
    status: 403,
    body: { code: 10403, data: { reason: 'admin_permission_denied' } },
  });
  expect(api.auth.getToken()).toBe(token);
  expect(await api.loadPermissions()).toMatchObject({
    username: a.username,
    snapshot: { isSuper: false, permissions: [] },
  });
}, 30_000);

it('[AC-F1-06zb#10] 退出同时清除本地会话与撤销服务端旧令牌，权限加载不能返回旧缓存', async () => {
  const f = await fixture(h);
  const a = await account(h);
  const { api } = clientFor(f);
  const token = await signIn(api, f, a);
  await api.loadPermissions();
  expect(await api.auth.logout()).toMatchObject({ success: true });
  expect(api.auth.getToken()).toBeNull();
  const response = await f.read(token);
  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({ code: 10001 });
  await expect(api.loadPermissions()).rejects.toBeInstanceOf(Error);
}, 30_000);

it('[AC-F1-06zb#11] 服务端撤销会话后每次权限加载重新请求，拒绝并清除前端令牌', async () => {
  const f = await fixture(h);
  const a = await account(h);
  const { api, exchanges } = clientFor(f);
  const token = await signIn(api, f, a);
  await api.loadPermissions();
  const response = await f.post('/logout', {}, { authorization: `Bearer ${token}` });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  expect(api.auth.getToken()).toBe(token);
  await expect(api.loadPermissions()).rejects.toMatchObject({ code: 10001, httpStatus: 401 });
  expect(exchanges.filter((exchange) => exchange.path === READ)).toHaveLength(2);
  expect(api.auth.getToken()).toBeNull();
}, 30_000);

it('[AC-F1-06zb#12] data 收到服务端会话失效 10001 时联动 auth 清除会话', async () => {
  const f = await fixture(h);
  const a = await account(h, { is_super: true });
  const { api } = clientFor(f);
  const token = await signIn(api, f, a);
  const response = await f.post('/logout', {}, { authorization: `Bearer ${token}` });
  expect(response.json()).toMatchObject({ code: 0 });
  await expect(
    api.data.getList({ resource: 'admins', pagination: { currentPage: 1, pageSize: 20 } }),
  ).rejects.toMatchObject({ code: 10001, httpStatus: 401 });
  expect(api.auth.getToken()).toBeNull();
  await expect(api.loadPermissions()).rejects.toBeInstanceOf(Error);
}, 30_000);
