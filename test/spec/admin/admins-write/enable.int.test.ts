import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { grant } from '../accounts/kit.ts';
import { login, totp } from '../auth/kit.ts';
import {
  alive,
  dead,
  error,
  expectAccount,
  harness,
  ok,
  setup,
  signInAgain,
  text,
  ticketGone,
  type Account,
} from './kit.ts';

// adminEnableAdmin (BR-ID-43「停用后台账号」; task §9: what the disable voided stays void).
// Before the implementation the route is not registered: every request fails its first status
// assertion.
const h = harness(createTestDatabase, acquireTestRedis);

it('[AC-B1-34h#18] 启用：恢复停用前的权限点，停用前的令牌与登录凭证仍然作废，重新登录可用，已取消的导出不恢复', async () => {
  const f = await setup(h);
  const a = await f.target();
  await grant(h, a, f.actor, ['user.list', 'fund.view']);
  const old = await signInAgain(f, a);
  f.clock.advanceMs(30_000);
  const pending = await login(f, a);
  const task = await f.exportTask(a.id, 'pending');
  await ok(await f.act('disable', a.id), 'disable');
  const before = await f.row(a.id);
  const result = await ok<Account>(await f.act('enable', a.id), 'enable');
  expectAccount(result, {
    ...a.expected,
    status: 'active',
    permissions: ['user.list', 'fund.view'],
    row_version: before.row_version + 1,
  });
  expect(await f.row(a.id)).toMatchObject({
    status: 'active',
    row_version: before.row_version + 1,
    password_hash: before.password_hash,
    password_must_change: before.password_must_change,
    totp_secret_cipher: before.totp_secret_cipher,
    totp_bound_at: before.totp_bound_at,
  });

  await dead(f, old.admin_token);
  ticketGone(
    await f.post('/totp', { login_ticket: pending.login_ticket, code: totp(a.secret, f.clock) }),
  );
  const fresh = await signInAgain(f, a);
  await alive(f, fresh.admin_token);
  expect((await f.exportRow(task.id)).status).toBe('cancelled');

  const audit = await f.audits('admin_account_enable');
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ app_id: f.appId, admin_id: f.actor.id });
  expect(text(audit[0])).toContain(a.id);
  expect(text(audit[0]!.before)).toContain('disabled');
  expect(text(audit[0]!.after)).toContain('active');
}, 30_000);

it('[AC-B1-34h#18] 启用不发新初始密码、不改验证器绑定：仍用初始密码的账号照旧先改密码', async () => {
  const f = await setup(h);
  const a = await f.onInitialPassword();
  await ok(await f.act('disable', a.id), 'disable');
  const result = await ok<Account>(await f.act('enable', a.id), 'enable');
  expect(result).not.toHaveProperty('initial_password');
  expect(result).toMatchObject({ status: 'active', totp_bound: false });
  expect(await f.row(a.id)).toMatchObject({ password_must_change: true, totp_bound_at: null });
  await login(f, a, 'change_password');
});

it.each([
  ['启用中的账号', 'active', 20902, { resource: 'admin_account' }],
  ['停用的超管', 'super', 10403, { reason: 'admin_permission_denied' }],
] as const)('[AC-B1-34h#19] 启用%s返回对应错误，什么都不变', async (_label, kind, code, data) => {
  const f = await setup(h);
  const a = await f.target(kind === 'super' ? { isSuper: true, status: 'disabled' } : {});
  const step = await f.issue();
  const before = await f.snapshot();
  await error(await f.send('enable', { token: f.token, id: a.id, step }), 'enable', code, data);
  expect(await f.snapshot()).toEqual(before);
});
