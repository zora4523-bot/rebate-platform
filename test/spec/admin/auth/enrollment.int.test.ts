import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { verifyAdminPassword } from '../../../../apps/api/src/modules/admin/application/bootstrap.ts';
import {
  account,
  binding,
  expiredTicket,
  failure,
  fixture,
  login,
  row,
  success,
  totp,
  useHarness,
  wrongCode,
  type Session,
  type Step,
} from './kit.ts';

const h = useHarness();
const unbound = { totp_secret_cipher: null, totp_bound_at: null };

it.each(['totp', 'change_password', 'bind_totp'] as const)(
  '[AC-F1-06k#39] $0 凭证在五分钟截止前一毫秒仍可完成对应步骤',
  async (next) => {
    const f = await fixture(h);
    const a = await account(
      h,
      next === 'totp'
        ? {}
        : {
            ...unbound,
            password_must_change: next === 'change_password',
          },
    );
    const step = await login(f, a, next);
    const secret =
      next === 'bind_totp' ? (await binding(f, step.login_ticket)).totp_secret : a.secret;
    f.clock.advanceMs(299_999);
    if (next === 'change_password') {
      const result = await success<Step>(
        await f.post('/password', {
          login_ticket: step.login_ticket,
          new_password: randomBytes(24).toString('base64url'),
        }),
        '/password',
      );
      expect(result.next).toBe('bind_totp');
      expect(result.ticket_expires_at).toBe(
        new Date(f.clock.now().getTime() + 300_000).toISOString(),
      );
    } else {
      const path = next === 'totp' ? '/totp' : '/totp/bind';
      const result = await success<Session>(
        await f.post(path, {
          login_ticket: step.login_ticket,
          code: totp(secret, f.clock),
        }),
        path,
      );
      expect(result.admin_token).toEqual(expect.any(String));
    }
  },
  30_000,
);

it('[AC-F1-06k#9] 首次登录先改密码再绑定，旧密码与旧凭证失效，完成绑定前无后台令牌', async () => {
  const f = await fixture(h);
  const a = await account(h, { ...unbound, password_must_change: true });
  const initial = await login(f, a, 'change_password');
  await expiredTicket(
    await f.post('/totp/secret', { login_ticket: initial.login_ticket }),
    '/totp/secret',
  );
  const replacement = randomBytes(24).toString('base64url');
  const next = await success<Step>(
    await f.post('/password', { login_ticket: initial.login_ticket, new_password: replacement }),
    '/password',
  );
  expect(next.next).toBe('bind_totp');
  expect(next.login_ticket).not.toBe(initial.login_ticket);
  expect(next.ticket_expires_at).toBe(new Date(f.clock.now().getTime() + 300_000).toISOString());
  expect(next).not.toHaveProperty('admin_token');
  const changed = await row(h, a);
  expect(changed.password_must_change).toBe(false);
  expect(changed.totp_bound_at).toBeNull();
  expect(await verifyAdminPassword(replacement, changed.password_hash)).toBe(true);
  expect(await verifyAdminPassword(a.password, changed.password_hash)).toBe(false);
  await expiredTicket(
    await f.post('/password', {
      login_ticket: initial.login_ticket,
      new_password: randomBytes(24).toString('hex'),
    }),
    '/password',
  );
  await expiredTicket(
    await f.post('/totp/secret', { login_ticket: initial.login_ticket }),
    '/totp/secret',
  );
  await failure(
    await f.post('/login', { username: a.username, password: a.password }),
    '/login',
    10008,
  );
  const secret = await binding(f, next.login_ticket);
  const code = totp(secret.totp_secret, f.clock);
  const response = await f.post('/totp/bind', { login_ticket: next.login_ticket, code });
  const session = await success<Session>(response, '/totp/bind');
  expect(session.admin_token).toEqual(expect.any(String));
  const bound = await row(h, a);
  expect(bound.totp_bound_at).toEqual(f.clock.now());
  expect(bound.failed_login_count).toBe(0);
  expect(bound.totp_secret_cipher).not.toBeNull();
  expect(bound.totp_secret_cipher!.toString()).not.toContain(secret.totp_secret);
  expect(
    h.fields.decrypt(bound.totp_secret_cipher!.toString(), `admin_users.totp_secret:couli:${a.id}`),
  ).toBe(secret.totp_secret);
  await expiredTicket(
    await f.post('/totp/bind', { login_ticket: next.login_ticket, code }),
    '/totp/bind',
  );
  await login(f, { ...a, password: replacement });
}, 30_000);

it.each(['short', 'long', 'initial', 'username'] as const)(
  '[AC-F1-06k#10] 新密码违反 $0 规则返回 20001 且不消耗凭证',
  async (kind) => {
    const f = await fixture(h);
    const a = await account(h, { ...unbound, password_must_change: true });
    const step = await login(f, a, 'change_password');
    const before = await row(h, a);
    const invalid = {
      short: randomBytes(5).toString('hex').slice(0, 9),
      long: randomBytes(65).toString('hex').slice(0, 129),
      initial: a.password,
      username: a.username,
    }[kind];
    await failure(
      await f.post('/password', { login_ticket: step.login_ticket, new_password: invalid }),
      '/password',
      20001,
      { fields: ['new_password'] },
    );
    expect(await row(h, a)).toEqual(before);
    const valid = randomBytes(24).toString('hex');
    expect(
      await success<Step>(
        await f.post('/password', { login_ticket: step.login_ticket, new_password: valid }),
        '/password',
      ),
    ).toMatchObject({ next: 'bind_totp' });
  },
  30_000,
);

it.each([10, 128])(
  '[AC-F1-06k#11] 新密码长度边界 %i 被接受',
  async (length) => {
    const f = await fixture(h);
    const a = await account(h, { ...unbound, password_must_change: true });
    const step = await login(f, a, 'change_password');
    const newPassword = randomBytes(128).toString('base64url').slice(0, length);
    const next = await success<Step>(
      await f.post('/password', { login_ticket: step.login_ticket, new_password: newPassword }),
      '/password',
    );
    expect(next.next).toBe('bind_totp');
    expect(await verifyAdminPassword(newPassword, (await row(h, a)).password_hash)).toBe(true);
  },
  30_000,
);

it('[AC-F1-06k#12] 同一绑定凭证读取同一密钥，新登录生成新密钥，读密钥不写绑定', async () => {
  const f = await fixture(h);
  const a = await account(h, unbound);
  const before = await row(h, a);
  const first = await login(f, a, 'bind_totp');
  const secret = await binding(f, first.login_ticket);
  expect(await binding(f, first.login_ticket)).toEqual(secret);
  expect(new URL(secret.otpauth_uri).searchParams.get('secret')).toBe(secret.totp_secret);
  expect(await row(h, a)).toEqual(before);
  const second = await login(f, a, 'bind_totp');
  expect(second.login_ticket).not.toBe(first.login_ticket);
  expect((await binding(f, second.login_ticket)).totp_secret).not.toBe(secret.totp_secret);
  f.clock.advanceMs(300_000);
  await expiredTicket(
    await f.post('/totp/secret', { login_ticket: second.login_ticket }),
    '/totp/secret',
  );
  const third = await login(f, a, 'bind_totp');
  expect((await binding(f, third.login_ticket)).totp_secret).not.toBe(secret.totp_secret);
  expect(await row(h, a)).toEqual(before);
}, 30_000);

it('[AC-F1-06k#13] 首次绑定错码与密码共用失败计数，不绑定且凭证可以重试', async () => {
  const f = await fixture(h);
  const a = await account(h, unbound);
  await failure(
    await f.post('/login', { username: a.username, password: randomBytes(20).toString('hex') }),
    '/login',
    10008,
  );
  const step = await login(f, a, 'bind_totp');
  const secret = await binding(f, step.login_ticket);
  await failure(
    await f.post('/totp/bind', {
      login_ticket: step.login_ticket,
      code: wrongCode(secret.totp_secret, f.clock),
    }),
    '/totp/bind',
    20002,
    { reason: 'totp_bind_invalid' },
  );
  expect(await row(h, a)).toMatchObject({
    failed_login_count: 2,
    totp_bound_at: null,
    totp_secret_cipher: null,
  });
  expect(await binding(f, step.login_ticket)).toEqual(secret);
  await success<Session>(
    await f.post('/totp/bind', {
      login_ticket: step.login_ticket,
      code: totp(secret.totp_secret, f.clock),
    }),
    '/totp/bind',
  );
  expect(await row(h, a)).toMatchObject({ failed_login_count: 0, totp_bound_at: f.clock.now() });
}, 30_000);

it('[AC-F1-06k#14] 首次绑定第五次失败立即锁定，正确动态码也不能绕过', async () => {
  const f = await fixture(h);
  const a = await account(h, { ...unbound, failed_login_count: 4 });
  const step = await login(f, a, 'bind_totp');
  const secret = await binding(f, step.login_ticket);
  const locked = { locked_until: new Date(f.clock.now().getTime() + 1_800_000).toISOString() };
  await failure(
    await f.post('/totp/bind', {
      login_ticket: step.login_ticket,
      code: wrongCode(secret.totp_secret, f.clock),
    }),
    '/totp/bind',
    10009,
    locked,
  );
  await failure(
    await f.post('/totp/bind', {
      login_ticket: step.login_ticket,
      code: totp(secret.totp_secret, f.clock),
    }),
    '/totp/bind',
    10009,
    locked,
  );
  expect(await row(h, a)).toMatchObject({
    failed_login_count: 5,
    totp_bound_at: null,
    totp_secret_cipher: null,
  });
}, 30_000);

it.each(['totp', 'change_password', 'bind_totp'] as const)(
  '[AC-F1-06k#15] $0 凭证在五分钟边界过期，过期判断不依赖 Redis 实际 TTL',
  async (next) => {
    const f = await fixture(h);
    const a = await account(
      h,
      next === 'totp' ? {} : { ...unbound, password_must_change: next === 'change_password' },
    );
    const step = await login(f, a, next);
    const secret =
      next === 'bind_totp' ? (await binding(f, step.login_ticket)).totp_secret : a.secret;
    f.clock.advanceMs(300_000);
    const calls =
      next === 'totp'
        ? [{ path: '/totp', body: { code: totp(secret, f.clock) } }]
        : next === 'change_password'
          ? [{ path: '/password', body: { new_password: randomBytes(24).toString('hex') } }]
          : [
              { path: '/totp/secret', body: {} },
              { path: '/totp/bind', body: { code: totp(secret, f.clock) } },
            ];
    const before = await row(h, a);
    for (const call of calls)
      await expiredTicket(
        await f.post(call.path, { login_ticket: step.login_ticket, ...call.body }),
        call.path,
      );
    expect(await row(h, a)).toEqual(before);
  },
  30_000,
);

it.each(['totp', 'change_password', 'bind_totp'] as const)(
  '[AC-F1-06k#16] $0 凭证不能用于其他步骤，也不能被伪造',
  async (next) => {
    const f = await fixture(h);
    const a = await account(
      h,
      next === 'totp' ? {} : { ...unbound, password_must_change: next === 'change_password' },
    );
    const step = await login(f, a, next);
    const endpoints = [
      {
        path: '/password',
        step: 'change_password',
        body: { new_password: randomBytes(24).toString('hex') },
      },
      { path: '/totp', step: 'totp', body: { code: totp(a.secret, f.clock) } },
      { path: '/totp/secret', step: 'bind_totp', body: {} },
      { path: '/totp/bind', step: 'bind_totp', body: { code: totp(a.secret, f.clock) } },
    ];
    const before = await row(h, a);
    for (const endpoint of endpoints) {
      if (endpoint.step !== next)
        await expiredTicket(
          await f.post(endpoint.path, { login_ticket: step.login_ticket, ...endpoint.body }),
          endpoint.path,
        );
      await expiredTicket(
        await f.post(endpoint.path, {
          login_ticket: randomBytes(32).toString('base64url'),
          ...endpoint.body,
        }),
        endpoint.path,
      );
    }
    expect(await row(h, a)).toEqual(before);
  },
  30_000,
);

it('[AC-F1-06k#17] 并发消费改密码凭证只有一次成功，另一请求得到已用凭证错误', async () => {
  const f = await fixture(h);
  const a = await account(h, { ...unbound, password_must_change: true });
  const step = await login(f, a, 'change_password');
  const results = await Promise.all(
    [0, 1].map(() =>
      f.post('/password', {
        login_ticket: step.login_ticket,
        new_password: randomBytes(24).toString('hex'),
      }),
    ),
  );
  expect(results.map((r) => r.json().code).sort((a, b) => a - b)).toEqual([0, 10001]);
  await expiredTicket(
    results.find((r) => r.json().code === 10001)!,
    '/password',
  );
  expect((await row(h, a)).password_must_change).toBe(false);
}, 30_000);
