import { createHmac, randomBytes, randomUUID, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import { decode } from '../../identity/token/kit.ts';
import {
  account,
  audits,
  AUTH,
  expiredTicket,
  factory,
  failure,
  fixture,
  login,
  READ,
  row,
  signedIn,
  success,
  SUPER,
  totp,
  useHarness,
  type Session,
} from './kit.ts';

const h = useHarness();

it('[AC-F1-06k#18] 真动态码完成登录，JWT 身份来自后台账号且声明 aud=admin、八小时有效期', async () => {
  const f = await fixture(h, { probes: true });
  const a = await account(h);
  const session = await signedIn(f, a);
  expect(await audits(h, a)).toHaveLength(1);
  const { header, payload } = decode(session.admin_token);
  expect(['HS256', 'ES256']).toContain(header['alg']);
  const issued = Math.floor(f.clock.now().getTime() / 1000);
  expect(payload).toMatchObject({
    sub: a.id,
    app_id: 'couli',
    aud: 'admin',
    iat: issued,
    exp: issued + 28_800,
    jti: expect.any(String),
  });
  expect(String(payload['jti']).length).toBeGreaterThan(0);
  expect(session.expires_at).toBe(new Date(f.clock.now().getTime() + 28_800_000).toISOString());
  expect(session.idle_timeout_sec).toBe(1800);
  expect((await f.read(session.admin_token)).statusCode).toBe(200);
  await failure(
    await f.read(session.admin_token, SUPER, {
      'x-admin-id': a.id,
      'x-is-super': 'true',
      'x-app-id': 'other',
    }),
    '/logout',
    10403,
    { reason: 'admin_permission_denied' },
  );
}, 30_000);

it('[AC-F1-06k#19] App 密钥即使签 aud=admin 也被拒，伪造签名、错 audience 与无签名令牌均为 10001', async () => {
  const f = await fixture(h, { probes: true });
  const a = await account(h);
  const session = await signedIn(f, a);
  const decoded = decode(session.admin_token);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const withAppKey = (payload: object) => {
    const input = `${encode({ alg: 'ES256', kid: h.env['JWT_KEY_ID'], typ: 'JWT' })}.${encode(payload)}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key: h.appKey.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  const appClaims = {
    uid: a.id,
    app_id: 'couli',
    sid: randomUUID(),
    device_id: randomUUID(),
    scp: 'full',
    iss: 'couli-api',
    aud: 'app',
    iat: decoded.payload['iat'],
    exp: decoded.payload['exp'],
  };
  const changedAudience = `${encode(decoded.header)}.${encode({ ...decoded.payload, aud: 'app' })}`;
  const wrongAudience = `${changedAudience}.${createHmac('sha256', Buffer.from(h.env['ADMIN_TOKEN_SIGNING_KEY']!, 'base64url')).update(changedAudience).digest('base64url')}`;
  const forged = `${decoded.input.toString()}.${randomBytes(decoded.signature.length).toString('base64url')}`;
  const unsigned = `${encode({ alg: 'none' })}.${encode(decoded.payload)}.`;
  for (const token of [
    withAppKey(appClaims),
    withAppKey(decoded.payload),
    wrongAudience,
    forged,
    unsigned,
  ]) {
    await failure(await f.read(token), '/logout', 10001);
  }
  expect((await f.read(session.admin_token)).statusCode).toBe(200);
}, 30_000);

it('[AC-F1-06k#20] 空闲恰满三十分钟失效，只有通过后台令牌检查的请求续期', async () => {
  const f = await fixture(h, { probes: true });
  const a = await account(h);
  const { admin_token: token } = await signedIn(f, a);
  f.clock.advanceMs(1_799_999);
  expect((await f.read(token)).statusCode).toBe(200);
  f.clock.advanceMs(1_799_999);
  expect((await f.read(token)).statusCode).toBe(200);
  f.clock.advanceMs(1_799_999);
  await failure(await f.read(token, READ, {}, '198.51.100.9'), '/logout', 10403, {
    reason: 'admin_ip_not_allowed',
  });
  f.clock.advanceMs(1);
  await failure(await f.read(token), '/logout', 10001);
}, 30_000);

it('[AC-F1-06k#21] 持续访问只能续空闲期，八小时绝对到期后仍须重新登录', async () => {
  const f = await fixture(h, { probes: true });
  const a = await account(h);
  const { admin_token: token } = await signedIn(f, a);
  for (let i = 0; i < 47; i += 1) {
    f.clock.advanceMs(600_000);
    expect((await f.read(token)).statusCode).toBe(200);
  }
  f.clock.advanceMs(599_999);
  expect((await f.read(token)).statusCode).toBe(200);
  f.clock.advanceMs(1);
  await failure(await f.read(token), '/logout', 10001);
}, 30_000);

it('[AC-F1-06k#22] 退出仅注销当前会话，同一令牌再次请求为 10001，不影响另一会话', async () => {
  const f = await fixture(h, { probes: true });
  const a = await account(h);
  const first = await signedIn(f, a);
  f.clock.advanceMs(30_000);
  const second = await signedIn(f, a);
  expect(decode(second.admin_token).payload['jti']).not.toBe(
    decode(first.admin_token).payload['jti'],
  );
  await success(
    await f.post('/logout', {}, { authorization: `Bearer ${first.admin_token}` }),
    '/logout',
  );
  await failure(await f.read(first.admin_token), '/logout', 10001);
  await failure(
    await f.post('/logout', {}, { authorization: `Bearer ${first.admin_token}` }),
    '/logout',
    10001,
  );
  expect((await f.read(second.admin_token)).statusCode).toBe(200);
}, 30_000);

it.each(['disabled', 'locked'] as const)(
  '[AC-F1-06k#23] 已签发令牌在账号 $0 后立即失效',
  async (state) => {
    const f = await fixture(h, { probes: true });
    const a = await account(h);
    const { admin_token: token } = await signedIn(f, a);
    await h.db
      .updateTable('admin_users')
      .set(
        state === 'disabled'
          ? { status: 'disabled' }
          : { failed_login_count: 5, locked_until: new Date(f.clock.now().getTime() + 1_800_000) },
      )
      .where('id', '=', a.id)
      .execute();
    await failure(await f.read(token), '/logout', 10001);
  },
  30_000,
);

it('[AC-F1-06k#24] 中间凭证不能调用后台接口，Cookie 不能代替 Bearer，超管才可到达 super 路由', async () => {
  const f = await fixture(h, { probes: true });
  for (const initial of [false, true]) {
    const a = await account(h, {
      totp_secret_cipher: null,
      totp_bound_at: null,
      password_must_change: initial,
    });
    const step = await login(f, a, initial ? 'change_password' : 'bind_totp');
    await failure(await f.read(step.login_ticket), '/logout', 10001);
    await failure(
      await f.post('/logout', {}, { authorization: `Bearer ${step.login_ticket}` }),
      '/logout',
      10001,
    );
  }
  const a = await account(h, { is_super: true });
  const step = await login(f, a);
  await failure(await f.read(step.login_ticket), '/logout', 10001);
  const session = await success<Session>(
    await f.post('/totp', { login_ticket: step.login_ticket, code: totp(a.secret, f.clock) }),
    '/totp',
  );
  expect((await f.read(session.admin_token, SUPER)).statusCode).toBe(200);
  await failure(
    await f.app.inject({
      method: 'GET',
      url: READ,
      headers: { cookie: `admin_token=${session.admin_token}` },
      remoteAddress: '127.0.0.1',
    }),
    '/logout',
    10001,
  );
  await failure(
    await f.app.inject({ method: 'GET', url: READ, remoteAddress: '127.0.0.1' }),
    '/logout',
    10001,
  );
}, 30_000);

it('[AC-F1-06k#25] 同一登录凭证并发消费只签发一次会话', async () => {
  const f = await fixture(h);
  const a = await account(h);
  const step = await login(f, a);
  const body = { login_ticket: step.login_ticket, code: totp(a.secret, f.clock) };
  const results = await Promise.all([f.post('/totp', body), f.post('/totp', body)]);
  expect(results.map((r) => r.json().code).sort((a, b) => a - b)).toEqual([0, 10001]);
  await expiredTicket(
    results.find((r) => r.json().code === 10001)!,
    '/totp',
  );
}, 30_000);

it('[AC-F1-06k#26] 凭证绑定账号，另一个账号的动态码不登录也不修改该账号', async () => {
  const f = await fixture(h);
  const a = await account(h);
  let b = await account(h);
  while ([-1, 0, 1].map((d) => totp(a.secret, f.clock, d)).includes(totp(b.secret, f.clock)))
    b = await account(h);
  const before = await row(h, b);
  const step = await login(f, a);
  await failure(
    await f.post('/totp', { login_ticket: step.login_ticket, code: totp(b.secret, f.clock) }),
    '/totp',
    20002,
    { reason: 'totp_invalid' },
  );
  expect(await row(h, b)).toEqual(before);
  const session = await success<Session>(
    await f.post('/totp', { login_ticket: step.login_ticket, code: totp(a.secret, f.clock) }),
    '/totp',
  );
  expect(decode(session.admin_token).payload['sub']).toBe(a.id);
}, 30_000);

it('[AC-F1-06k#27] admin 不暴露 /v1，api 与 stream 仍禁止后台路由注册', async () => {
  const admin = await fixture(h, { probes: true });
  const a = await account(h);
  await signedIn(admin, a);
  expect(
    (await admin.app.inject({ method: 'POST', url: '/v1/auth/login/sms', payload: '{}' }))
      .statusCode,
  ).toBe(404);
  for (const entry of ['api', 'stream'] as const) {
    const f = await fixture(h, { entry });
    expect(
      (await f.post('/login', { username: a.username, password: a.password })).statusCode,
    ).toBe(404);
    expect((await f.app.inject({ method: 'POST', url: `${AUTH}/logout` })).statusCode).toBe(404);
    const refusing = await (await factory())(entry, f.overrides);
    h.apps.push(refusing);
    expect(() =>
      refusing
        .getHttpAdapter()
        .getInstance()
        .get(SUPER, () => ({ code: 0 })),
    ).toThrow(/admin/i);
  }
}, 30_000);
