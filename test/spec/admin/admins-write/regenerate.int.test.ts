import { randomBytes } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { verifyAdminPassword } from '../../../../apps/api/src/modules/admin/application/bootstrap.ts';
import { grant } from '../accounts/kit.ts';
import { failure, login, NOW } from '../auth/kit.ts';
import {
  credentials,
  error,
  expectAbsent,
  expectAccount,
  harness,
  ok,
  setup,
  text,
  ticketGone,
  type Created,
  type Setup,
} from './kit.ts';

// adminRegenerateAdminInitialPassword (BR-ID-43「重新生成初始密码」, D10-143). Before the
// implementation the route is not registered: every request fails its first status assertion.
const h = harness(createTestDatabase, acquireTestRedis);

it('[AC-B1-34h#11] 重新生成初始密码：新密码只出现一次，旧初始密码与未走完的改密凭证作废，账号其余不变', async () => {
  const f = await setup(h);
  const a = await f.onInitialPassword();
  await grant(h, a, f.actor, ['user.list']);
  const pending = await login(f, a, 'change_password');
  const before = await f.row(a.id);
  const response = await f.act('regenerate', a.id);
  const result = await ok<Created>(response, 'regenerate');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(result.initial_password).not.toBe(h.password);
  expectAccount(result.account, {
    ...a.expected,
    totp_bound: false,
    permissions: ['user.list'],
    row_version: before.row_version + 1,
  });
  const after = await f.row(a.id);
  expect(after).toEqual({
    ...before,
    password_hash: after.password_hash,
    row_version: before.row_version + 1,
    updated_at: after.updated_at,
  });
  expect(await verifyAdminPassword(result.initial_password, after.password_hash)).toBe(true);
  expect(await verifyAdminPassword(h.password, after.password_hash)).toBe(false);
  expect(await f.permissionKeys(a.id)).toEqual(['user.list']);

  // The ticket from before cannot finish its step; the old password no longer signs in.
  ticketGone(
    await f.post('/password', {
      login_ticket: pending.login_ticket,
      new_password: randomBytes(24).toString('base64url'),
    }),
  );
  await failure(
    await f.post('/login', { username: a.username, password: h.password }),
    '/login',
    10008,
  );
  await login(f, credentials(a.id, a.username, result.initial_password), 'change_password');

  const audit = await f.audits('admin_initial_password_regenerate');
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ app_id: f.appId, admin_id: f.actor.id });
  expect(text(audit[0])).toContain(a.id);
  expectAbsent(f, await f.audits(), result.initial_password);
}, 30_000);

it('[AC-B1-34h#11] 再次重新生成使上一次生成的初始密码失效', async () => {
  const f = await setup(h);
  const a = await f.onInitialPassword();
  const first = await ok<Created>(await f.act('regenerate', a.id), 'regenerate');
  const second = await ok<Created>(await f.act('regenerate', a.id), 'regenerate');
  expect(second.initial_password).not.toBe(first.initial_password);
  expect(second.account.row_version).toBe(first.account.row_version! + 1);
  await failure(
    await f.post('/login', { username: a.username, password: first.initial_password }),
    '/login',
    10008,
  );
  await login(f, credentials(a.id, a.username, second.initial_password), 'change_password');
}, 30_000);

type Case = readonly [string, (f: Setup) => Promise<{ id: string }>, 10403 | 20902, object];
const CASES: readonly Case[] = [
  ['已改掉初始密码且已绑定', (f) => f.target(), 20902, { resource: 'admin_account' }],
  [
    '已改掉初始密码但未绑定',
    (f) => f.target({ bound: false }),
    20902,
    { resource: 'admin_account' },
  ],
  [
    '仍用初始密码但已绑定验证器',
    async (f) => {
      const a = await f.onInitialPassword();
      await h.db
        .updateTable('admin_users')
        .set({ totp_bound_at: NOW })
        .where('id', '=', a.id)
        .execute();
      return a;
    },
    20902,
    { resource: 'admin_account' },
  ],
  [
    '另一位超管',
    async (f) => {
      const a = await f.onInitialPassword();
      await h.db
        .updateTable('admin_users')
        .set({ is_super: true })
        .where('id', '=', a.id)
        .execute();
      return a;
    },
    10403,
    { reason: 'admin_permission_denied' },
  ],
  ['调用者本人', async (f) => f.actor, 10403, { reason: 'admin_permission_denied' }],
];

it.each(CASES)(
  '[AC-B1-34h#12] 目标不符合条件（%s）不重新生成，返回对应错误且什么都不变',
  async (_label, make, code, data) => {
    const f = await setup(h);
    const a = await make(f);
    const step = await f.issue();
    const before = await f.snapshot();
    await error(
      await f.send('regenerate', { token: f.token, id: a.id, step }),
      'regenerate',
      code,
      data,
    );
    expect(await f.snapshot()).toEqual(before);
  },
);
