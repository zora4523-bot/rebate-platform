import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import * as passwords from '../../../../apps/api/src/modules/admin/application/bootstrap.ts';
import {
  account,
  audits,
  binding,
  expiredTicket,
  failure,
  fixture,
  login,
  row,
  signedIn,
  success,
  totp,
  useHarness,
  wrongCode,
  type Session,
} from './kit.ts';

const h = useHarness();

it('[AC-F1-06k#1] 白名单先于密码、正文校验和账号读取，拒绝不增加失败计数', async () => {
  const verify = vi.spyOn(passwords, 'verifyAdminPassword');
  try {
    const f = await fixture(h);
    const a = await account(h);
    verify.mockClear();
    const before = await row(h, a);
    for (const body of [{ username: a.username, password: randomBytes(20).toString('hex') }, {}]) {
      await failure(
        await f.post('/login', body, { 'x-forwarded-for': '127.0.0.1' }, '198.51.100.10'),
        '/login',
        10403,
        { reason: 'admin_ip_not_allowed' },
      );
    }
    expect(verify).not.toHaveBeenCalled();
    expect(await row(h, a)).toEqual(before);
    expect(await audits(h, a)).toEqual([]);
    await login(f, a);
  } finally {
    verify.mockRestore();
  }
}, 30_000);

it('[AC-F1-06k#2] 不存在的账号与密码错误同为不带 data 的 10008，未知账号也进行哈希比对', async () => {
  const verify = vi.spyOn(passwords, 'verifyAdminPassword');
  try {
    const f = await fixture(h);
    const a = await account(h);
    const badPassword = randomBytes(20).toString('base64url');
    const known = await f.post('/login', { username: a.username, password: badPassword });
    await failure(known, '/login', 10008);
    expect((await row(h, a)).failed_login_count).toBe(1);
    verify.mockClear();
    const before = await h.db.selectFrom('admin_users').selectAll().orderBy('id').execute();
    const unknown = await f.post('/login', {
      username: `missing-${randomUUID()}`,
      password: badPassword,
    });
    await failure(unknown, '/login', 10008);
    expect(unknown.json<{ msg: string }>().msg).toBe(known.json<{ msg: string }>().msg);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[0]).toBe(badPassword);
    expect(verify.mock.calls[0]?.[1]).toMatch(
      /^scrypt\$v=1\$N=131072\$r=8\$p=1\$[0-9a-f]{32}\$[0-9a-f]{128}$/,
    );
    expect(await h.db.selectFrom('admin_users').selectAll().orderBy('id').execute()).toEqual(
      before,
    );
  } finally {
    verify.mockRestore();
  }
}, 30_000);

it.each([
  { next: 'totp', bound: true, initial: false },
  { next: 'change_password', bound: false, initial: true },
  { next: 'bind_totp', bound: false, initial: false },
] as const)(
  '[AC-F1-06k#3] 密码正确只发五分钟不透明凭证，next=$next，不提前清零失败计数',
  async ({ next, bound, initial }) => {
    const f = await fixture(h);
    const a = await account(h, {
      password_must_change: initial,
      failed_login_count: 2,
      ...(bound ? {} : { totp_secret_cipher: null, totp_bound_at: null }),
    });
    const step = await login(f, a, next);
    expect(step.login_ticket.length).toBeGreaterThanOrEqual(22);
    expect(step.login_ticket.split('.')).not.toHaveLength(3);
    expect(step.login_ticket).not.toContain(a.id);
    expect((await row(h, a)).failed_login_count).toBe(2);
    expect(await audits(h, a)).toEqual([]);
  },
  30_000,
);

it('[AC-F1-06k#4] 第五次错误锁定三十分钟，锁定中正确密码被拒，到期重新计数且可完成登录', async () => {
  const f = await fixture(h);
  const a = await account(h);
  const lockedUntil = new Date(f.clock.now().getTime() + 1_800_000).toISOString();
  for (let i = 1; i <= 5; i += 1) {
    const response = await f.post('/login', {
      username: a.username,
      password: randomBytes(20).toString('hex'),
    });
    if (i < 5) await failure(response, '/login', 10008);
    else await failure(response, '/login', 10009, { locked_until: lockedUntil });
    expect((await row(h, a)).failed_login_count).toBe(i);
  }
  const locked = await row(h, a);
  expect(locked.locked_until?.toISOString()).toBe(lockedUntil);
  f.clock.advanceMs(1_799_999);
  await failure(
    await f.post('/login', { username: a.username, password: a.password }),
    '/login',
    10009,
    { locked_until: lockedUntil },
  );
  expect(await row(h, a)).toEqual(locked);
  f.clock.advanceMs(1);
  await failure(
    await f.post('/login', { username: a.username, password: randomBytes(20).toString('hex') }),
    '/login',
    10008,
  );
  expect((await row(h, a)).failed_login_count).toBe(1);
  await signedIn(f, a);
  expect(await row(h, a)).toMatchObject({ failed_login_count: 0, locked_until: null });
}, 30_000);

it('[AC-F1-06k#5] 同时发生的五次失败无丢失更新且只写一条锁定审计', async () => {
  const f = await fixture(h);
  const a = await account(h);
  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      f.post('/login', {
        username: a.username,
        password: randomBytes(20).toString('hex'),
      }),
    ),
  );
  expect(responses.map((r) => r.json().code).sort()).toEqual([10008, 10008, 10008, 10008, 10009]);
  expect(await row(h, a)).toMatchObject({
    failed_login_count: 5,
    locked_until: new Date(f.clock.now().getTime() + 1_800_000),
  });
  expect(await audits(h, a)).toHaveLength(1);
}, 30_000);

it('[AC-F1-06k#6] 密码错误与第二步动态码错误共用计数，错码可重试而成功清零', async () => {
  const f = await fixture(h);
  const a = await account(h);
  await failure(
    await f.post('/login', { username: a.username, password: randomBytes(20).toString('hex') }),
    '/login',
    10008,
  );
  const step = await login(f, a);
  await failure(
    await f.post('/totp', { login_ticket: step.login_ticket, code: wrongCode(a.secret, f.clock) }),
    '/totp',
    20002,
    { reason: 'totp_invalid' },
  );
  expect((await row(h, a)).failed_login_count).toBe(2);
  const code = totp(a.secret, f.clock);
  await success<Session>(await f.post('/totp', { login_ticket: step.login_ticket, code }), '/totp');
  expect((await row(h, a)).failed_login_count).toBe(0);
  await expiredTicket(await f.post('/totp', { login_ticket: step.login_ticket, code }), '/totp');
}, 30_000);

it.each(['totp', 'bind_totp', 'change_password'] as const)(
  '[AC-F1-06k#7] 锁定立即约束已签发的 $0 中间凭证',
  async (next) => {
    const f = await fixture(h);
    const a = await account(
      h,
      next === 'totp'
        ? {}
        : {
            totp_secret_cipher: null,
            totp_bound_at: null,
            password_must_change: next === 'change_password',
          },
    );
    const step = await login(f, a, next);
    const secret =
      next === 'bind_totp' ? (await binding(f, step.login_ticket)).totp_secret : a.secret;
    // Simulates a different concurrent login crossing the shared lock threshold.
    const lockedUntil = new Date(f.clock.now().getTime() + 1_800_000);
    await h.db
      .updateTable('admin_users')
      .set({ failed_login_count: 5, locked_until: lockedUntil })
      .where('id', '=', a.id)
      .execute();
    const calls =
      next === 'totp'
        ? [{ path: '/totp', body: { code: totp(secret, f.clock) } }]
        : next === 'change_password'
          ? [{ path: '/password', body: { new_password: randomBytes(24).toString('hex') } }]
          : [
              { path: '/totp/secret', body: {} },
              { path: '/totp/bind', body: { code: totp(secret, f.clock) } },
            ];
    for (const call of calls) {
      await failure(
        await f.post(call.path, { login_ticket: step.login_ticket, ...call.body }),
        call.path,
        10009,
        { locked_until: lockedUntil.toISOString() },
      );
    }
    expect((await row(h, a)).failed_login_count).toBe(5);
  },
  30_000,
);

it('[AC-F1-06k#8] 密码已通过的凭证也不能绕过第五次动态码失败的锁定', async () => {
  const f = await fixture(h);
  const a = await account(h, { failed_login_count: 4 });
  const step = await login(f, a);
  const data = { locked_until: new Date(f.clock.now().getTime() + 1_800_000).toISOString() };
  await failure(
    await f.post('/totp', { login_ticket: step.login_ticket, code: wrongCode(a.secret, f.clock) }),
    '/totp',
    10009,
    data,
  );
  await failure(
    await f.post('/totp', { login_ticket: step.login_ticket, code: totp(a.secret, f.clock) }),
    '/totp',
    10009,
    data,
  );
  expect((await row(h, a)).failed_login_count).toBe(5);
}, 30_000);
