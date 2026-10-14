import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  account,
  audits,
  AUTH,
  binding,
  failure,
  fixture,
  login,
  ORIGIN,
  READ,
  row,
  signedIn,
  success,
  totp,
  useHarness,
  validate,
  type Session,
  type Step,
} from './kit.ts';

const h = useHarness();

it('[AC-F1-06k#33] 每一步和已登录请求都先检查来源 IP，不能伪造 X-Forwarded-For', async () => {
  const f = await fixture(h, { probes: true });
  const a = await account(h);
  const session = await signedIn(f, a);
  const before = await row(h, a);
  const records = await audits(h, a);
  for (const suffix of ['/login', '/password', '/totp/secret', '/totp/bind', '/totp', '/logout']) {
    await failure(
      await f.post(
        suffix,
        {},
        { authorization: `Bearer ${session.admin_token}`, 'x-forwarded-for': '127.0.0.1' },
        '198.51.100.20',
      ),
      suffix,
      10403,
      { reason: 'admin_ip_not_allowed' },
    );
  }
  await failure(await f.read(session.admin_token, READ, {}, '198.51.100.20'), '/logout', 10403, {
    reason: 'admin_ip_not_allowed',
  });
  for (const ip of ['192.0.2.1', '192.0.2.254', '2001:db8::42', '::1'])
    expect((await f.read(session.admin_token, READ, {}, ip)).statusCode).toBe(200);
  expect(await row(h, a)).toEqual(before);
  expect(await audits(h, a)).toEqual(records);
}, 30_000);

it.each(['local', 'test'])(
  '[AC-F1-06k#34] %s 缺后台密钥时可登录，未配置白名单只放回环',
  async (appEnv) => {
    const f = await fixture(h, {
      env: { APP_ENV: appEnv, ADMIN_TOKEN_SIGNING_KEY: '', ADMIN_IP_ALLOWLIST: '' },
    });
    const a = await account(h);
    for (const ip of ['127.0.0.1', '::1'])
      await success<Step>(
        await f.post('/login', { username: a.username, password: a.password }, {}, ip),
        '/login',
      );
    for (const ip of ['192.0.2.1', '2001:db8::1', '198.51.100.1'])
      await failure(
        await f.post('/login', { username: a.username, password: a.password }, {}, ip),
        '/login',
        10403,
        { reason: 'admin_ip_not_allowed' },
      );
    const session = await signedIn(f, a);
    expect(session.admin_token).toEqual(expect.any(String));
  },
  30_000,
);

it('[AC-F1-06k#35] 已配置可信代理时白名单使用 request.ip 的可信解析结果', async () => {
  const f = await fixture(h, { env: { TRUSTED_PROXIES: '198.51.100.0/24' } });
  const a = await account(h);
  const body = { username: a.username, password: a.password };
  await success<Step>(
    await f.post('/login', body, { 'x-forwarded-for': '192.0.2.4' }, '198.51.100.7'),
    '/login',
  );
  await failure(
    await f.post('/login', body, { 'x-forwarded-for': '127.0.0.1, 203.0.113.4' }, '198.51.100.7'),
    '/login',
    10403,
    { reason: 'admin_ip_not_allowed' },
  );
  expect((await row(h, a)).failed_login_count).toBe(0);
}, 30_000);

it('[AC-F1-06k#36] 后台只给确切前端来源 CORS，合法预检允许 Authorization 与 Content-Type', async () => {
  const f = await fixture(h);
  const a = await account(h);
  const response = await f.post(
    '/login',
    { username: a.username, password: a.password },
    { origin: ORIGIN },
  );
  await success<Step>(response, '/login');
  expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
  const preflight = await f.app.inject({
    method: 'OPTIONS',
    url: `${AUTH}/login`,
    remoteAddress: '127.0.0.1',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  expect([200, 204]).toContain(preflight.statusCode);
  expect(preflight.headers['access-control-allow-origin']).toBe(ORIGIN);
  expect(String(preflight.headers['access-control-allow-methods'])).toContain('POST');
  const headers = String(preflight.headers['access-control-allow-headers']).toLowerCase();
  expect(headers).toContain('authorization');
  expect(headers).toContain('content-type');
  for (const origin of ['https://other.example.invalid', `${ORIGIN}.attacker.invalid`, 'null']) {
    const denied = await f.post(
      '/login',
      { username: a.username, password: a.password },
      { origin },
    );
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    const preflightDenied = await f.app.inject({
      method: 'OPTIONS',
      url: `${AUTH}/login`,
      remoteAddress: '127.0.0.1',
      headers: { origin, 'access-control-request-method': 'POST' },
    });
    expect(preflightDenied.headers['access-control-allow-origin']).toBeUndefined();
  }
}, 30_000);

it('[AC-F1-06k#37] Redis 不可用时登录各步与后台令牌检查一律拒绝，不改密码或完成绑定', async () => {
  const f = await fixture(h, { probes: true });
  const normal = await account(h);
  const change = await account(h, {
    password_must_change: true,
    totp_bound_at: null,
    totp_secret_cipher: null,
  });
  const bind = await account(h, { totp_bound_at: null, totp_secret_cipher: null });
  const session = await signedIn(f, normal);
  f.clock.advanceMs(30_000);
  const totpStep = await login(f, normal);
  const passwordStep = await login(f, change, 'change_password');
  const bindStep = await login(f, bind, 'bind_totp');
  const secret = await binding(f, bindStep.login_ticket);
  const before = await Promise.all([normal, change, bind].map((a) => row(h, a)));
  await f.closeRedis();
  const calls = [
    { path: '/login', body: { username: normal.username, password: normal.password } },
    {
      path: '/totp',
      body: { login_ticket: totpStep.login_ticket, code: totp(normal.secret, f.clock) },
    },
    {
      path: '/password',
      body: {
        login_ticket: passwordStep.login_ticket,
        new_password: randomBytes(24).toString('hex'),
      },
    },
    { path: '/totp/secret', body: { login_ticket: bindStep.login_ticket } },
    {
      path: '/totp/bind',
      body: { login_ticket: bindStep.login_ticket, code: totp(secret.totp_secret, f.clock) },
    },
  ];
  for (const call of calls) {
    const response = await f.post(call.path, call.body);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).not.toBe(404);
    expect(response.json().code).not.toBe(0);
    await validate(response, call.path);
  }
  const protectedResponse = await f.read(session.admin_token);
  expect(protectedResponse.statusCode).toBeGreaterThanOrEqual(400);
  expect(protectedResponse.statusCode).not.toBe(404);
  expect(protectedResponse.json().code).not.toBe(0);
  await validate(protectedResponse, '/logout');
  expect(await Promise.all([normal, change, bind].map((a) => row(h, a)))).toEqual(before);
}, 30_000);

it('[AC-F1-06k#38] 改密码、绑定、登录、退出和锁定逐事件审计，审计和日志不含认证秘密', async () => {
  const f = await fixture(h, { probes: true });
  const a = await account(h, {
    password_must_change: true,
    totp_bound_at: null,
    totp_secret_cipher: null,
  });
  const initial = await login(f, a, 'change_password');
  expect(await audits(h, a)).toHaveLength(0);
  const password = randomBytes(24).toString('base64url');
  const step = await success<Step>(
    await f.post('/password', { login_ticket: initial.login_ticket, new_password: password }),
    '/password',
  );
  const changed = await audits(h, a);
  expect(changed).toHaveLength(1);
  const secret = await binding(f, step.login_ticket);
  expect(await audits(h, a)).toEqual(changed);
  const code = totp(secret.totp_secret, f.clock);
  const session = await success<Session>(
    await f.post('/totp/bind', { login_ticket: step.login_ticket, code }),
    '/totp/bind',
  );
  const bound = await audits(h, a);
  expect(bound).toHaveLength(3); // one binding and one completed-login event
  expect(new Set(bound.map((r) => r.action)).size).toBe(3);
  expect((await f.read(session.admin_token)).statusCode).toBe(200);
  expect(await audits(h, a)).toEqual(bound);
  await success(
    await f.post('/logout', {}, { authorization: `Bearer ${session.admin_token}` }),
    '/logout',
  );
  expect(await audits(h, a)).toHaveLength(4);
  await failure(
    await f.post('/logout', {}, { authorization: `Bearer ${session.admin_token}` }),
    '/logout',
    10001,
  );
  expect(await audits(h, a)).toHaveLength(4);
  await h.db
    .updateTable('admin_users')
    .set({ failed_login_count: 4 })
    .where('id', '=', a.id)
    .execute();
  const badPassword = randomBytes(24).toString('base64url');
  await failure(
    await f.post('/login', { username: a.username, password: badPassword }),
    '/login',
    10009,
    { locked_until: new Date(f.clock.now().getTime() + 1_800_000).toISOString() },
  );
  const records = await audits(h, a);
  expect(records).toHaveLength(5);
  expect(new Set(records.map((r) => r.action)).size).toBe(5);
  for (const record of records)
    expect(record).toMatchObject({
      app_id: 'couli',
      admin_id: a.id,
      ip: '127.0.0.1',
      at: f.clock.now(),
    });
  const serialized =
    JSON.stringify(records, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ) + f.lines.join('');
  for (const sensitive of [
    a.password,
    password,
    badPassword,
    secret.totp_secret,
    secret.otpauth_uri,
    code,
    initial.login_ticket,
    step.login_ticket,
    session.admin_token,
    h.passwordHash,
  ])
    expect(serialized).not.toContain(sensitive);
}, 30_000);
