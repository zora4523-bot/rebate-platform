import { randomBytes, randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { verifyAdminPassword } from '../../../../apps/api/src/modules/admin/application/bootstrap.ts';
import { expectNoSensitive, seed } from '../accounts/kit.ts';
import { binding, failure, login, success, totp, type Session, type Step } from '../auth/kit.ts';
import {
  alive,
  bodyOf,
  credentials,
  error,
  expectAbsent,
  expectAccount,
  harness,
  ok,
  setup,
  text,
  type Created,
} from './kit.ts';

// HTTP acceptance of adminCreateAdmin (BR-ID-43「初始密码」, task §9). Before the implementation
// the route is not registered, so every request fails its first status assertion.
const h = harness(createTestDatabase, acquireTestRedis);

it('[AC-B1-34h#3] 超管新建普通账号：显示名去首尾空白，初始密码只在本次响应出现，库里只存哈希并写审计', async () => {
  const f = await setup(h);
  const username = `cs-${randomUUID()}`;
  const response = await f.act('create', undefined, { username, display_name: '  客服小狸  ' });
  const created = await ok<Created>(response, 'create');
  expect(response.headers['cache-control']).toBe('no-store');
  const id = created.account.admin_id;
  const stored = await f.row(id);
  expectAccount(created.account, {
    admin_id: id,
    username,
    display_name: '客服小狸',
    is_super: false,
    status: 'active',
    totp_bound: false,
    verify_phone_masked: null,
    locked_until: null,
    permissions: [],
    created_at: f.clock.now().toISOString(),
    row_version: stored.row_version,
  });
  expect(stored).toMatchObject({
    app_id: f.appId,
    login_name: username,
    display_name: '客服小狸',
    is_super: false,
    status: 'active',
    password_must_change: true,
    totp_secret_cipher: null,
    totp_bound_at: null,
    verify_phone_cipher: null,
    verify_phone_hmac: null,
    locked_until: null,
    failed_login_count: 0,
  });
  expect(stored.password_hash).not.toContain(created.initial_password);
  expect(await verifyAdminPassword(created.initial_password, stored.password_hash)).toBe(true);
  expect(await f.permissionKeys(id)).toEqual([]);

  const audit = await f.audits('admin_account_create');
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ app_id: f.appId, admin_id: f.actor.id });
  for (const value of [id, username, '客服小狸']) expect(text(audit[0])).toContain(value);
  expectAbsent(f, await f.audits(), created.initial_password);

  // Never readable again: the reads show the account and its display name, no password.
  const again = await f.detail(id);
  expect(again).toMatchObject({
    admin_id: id,
    username,
    display_name: '客服小狸',
    status: 'active',
  });
  expectNoSensitive(again, [created.initial_password, stored.password_hash]);
  const listed = await f.page();
  expect(listed.items.find((item) => item.admin_id === id)).toMatchObject({
    display_name: '客服小狸',
  });
  expectNoSensitive(listed, [created.initial_password, stored.password_hash]);
});

it('[AC-B1-34h#4] 新账号首次登录先改掉初始密码再绑定验证器，改掉后初始密码失效', async () => {
  const f = await setup(h);
  const username = `cs-${randomUUID()}`;
  const created = await ok<Created>(
    await f.act('create', undefined, { username, display_name: '客服' }),
    'create',
  );
  const a = credentials(created.account.admin_id, username, created.initial_password);
  const first = await login(f, a, 'change_password');
  const replacement = randomBytes(24).toString('base64url');
  const next = await success<Step>(
    await f.post('/password', { login_ticket: first.login_ticket, new_password: replacement }),
    '/password',
  );
  expect(next.next).toBe('bind_totp');
  const secret = await binding(f, next.login_ticket);
  const session = await success<Session>(
    await f.post('/totp/bind', {
      login_ticket: next.login_ticket,
      code: totp(secret.totp_secret, f.clock),
    }),
    '/totp/bind',
  );
  await alive(f, session.admin_token);
  await failure(
    await f.post('/login', { username, password: created.initial_password }),
    '/login',
    10008,
  );
  expect(await f.detail(a.id)).toMatchObject({ totp_bound: true, status: 'active' });
}, 30_000);

it.each(['active', 'disabled', 'other-app'] as const)(
  '[AC-B1-34h#5] 账号名已被占用（%s）返回 20001 username，不建账号、不写审计',
  async (kind) => {
    const f = await setup(h);
    const holder =
      kind === 'other-app'
        ? await seed(h, `w_${randomUUID().replaceAll('-', '').slice(0, 24)}`)
        : await f.target({ status: kind });
    const step = await f.issue();
    const before = await f.snapshot();
    await error(
      await f.send('create', {
        token: f.token,
        step,
        body: { username: holder.username, display_name: '重名账号' },
      }),
      'create',
      20001,
      { fields: ['username'] },
    );
    expect(await f.snapshot()).toEqual(before);
  },
);

it.each([
  // undefined leaves the key out of the JSON body.
  ['display_name 缺失', { display_name: undefined }, 'display_name'],
  ['display_name 为空', { display_name: '' }, 'display_name'],
  ['display_name 去空白后为空', { display_name: '   ' }, 'display_name'],
  ['display_name 33 字', { display_name: '名'.repeat(33) }, 'display_name'],
  ['username 缺失', { username: undefined }, 'username'],
  ['username 为空', { username: '' }, 'username'],
  ['username 65 字符', { username: 'a'.repeat(65) }, 'username'],
] as const)(
  '[AC-B1-34h#6] 新建参数不合法（%s）返回 20001 并指出该字段',
  async (_label, patch, field) => {
    const f = await setup(h);
    const body = { username: `cs-${randomUUID()}`, display_name: '客服', ...patch };
    const step = await f.issue();
    const before = await f.snapshot();
    await error(await f.send('create', { token: f.token, step, body }), 'create', 20001, {
      fields: [field],
    });
    expect(await f.snapshot()).toEqual(before);
  },
);

it.each([
  ['权限点', { permissions: ['user.list'] }],
  ['超管标志', { is_super: true }],
])('[AC-B1-34h#6] 新建请求带%s返回 20001，不建账号', async (_label, extra) => {
  const f = await setup(h);
  const step = await f.issue();
  const before = await f.snapshot();
  const response = await f.send('create', {
    token: f.token,
    step,
    body: { ...(bodyOf('create') as object), ...extra },
  });
  await error(response, 'create', 20001);
  expect(await f.snapshot()).toEqual(before);
});

it('[AC-B1-34h#6] 64 字符账号名与 32 字显示名可以新建', async () => {
  const f = await setup(h);
  const username = `${'a'.repeat(28)}${randomUUID()}`;
  expect(username).toHaveLength(64);
  const created = await ok<Created>(
    await f.act('create', undefined, { username, display_name: '名'.repeat(32) }),
    'create',
  );
  expect(created.account).toMatchObject({ username, display_name: '名'.repeat(32) });
});

it.each(['missing', 'invalid', 'expired', 'used'] as const)(
  '[AC-B1-34h#7] 新建缺少有效的动态码档 step-up（%s）返回 10003 tier=totp，不建账号',
  async (kind) => {
    const f = await setup(h);
    let step: string | undefined;
    if (kind === 'invalid') step = 'not-a-step-up-token';
    if (kind === 'expired') {
      step = await f.issue();
      f.clock.advanceMs(300_000);
    }
    if (kind === 'used') {
      step = await f.issue();
      await ok(await f.send('create', { token: f.token, step, body: bodyOf('create')! }), 'create');
    }
    const before = await f.snapshot();
    await error(
      await f.send('create', {
        token: f.token,
        body: bodyOf('create')!,
        ...(step === undefined ? {} : { step }),
      }),
      'create',
      10003,
      { tier: 'totp' },
    );
    expect(await f.snapshot()).toEqual(before);
  },
);
