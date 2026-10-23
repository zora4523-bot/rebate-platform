import { randomBytes } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { verifyAdminPassword } from '../../../../apps/api/src/modules/admin/application/bootstrap.ts';
import { grant } from '../accounts/kit.ts';
import { binding, login, success, totp, type Session } from '../auth/kit.ts';
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

// adminResetAdminTotp (BR-ID-43「重置身份验证器」; task §9: sessions and login tickets voided per
// account). Before the implementation the route is not registered: every request fails its first
// status assertion.
const h = harness(createTestDatabase, acquireTestRedis);

it('[AC-B1-34h#20] 重置验证器：丢弃密钥回到未绑定，会话作废，其余不变，写审计；下次登录绑定新密钥', async () => {
  const f = await setup(h);
  const a = await f.target({ phone: '13812345678' });
  await grant(h, a, f.actor, ['user.list']);
  const own = await signInAgain(f, a);
  const step = await f.issue();
  await alive(f, own.admin_token);
  const before = await f.row(a.id);
  const reason = '本人换手机，已在企业微信视频通话里核对本人身份';
  const result = await ok<Account>(
    await f.send('reset', { token: f.token, id: a.id, body: { reason }, step }),
    'reset',
  );
  expectAccount(result, {
    ...a.expected,
    totp_bound: false,
    permissions: ['user.list'],
    row_version: before.row_version + 1,
  });
  expect(await f.row(a.id)).toMatchObject({
    totp_secret_cipher: null,
    totp_bound_at: null,
    status: before.status,
    password_hash: before.password_hash,
    password_must_change: before.password_must_change,
    verify_phone_cipher: before.verify_phone_cipher,
    verify_phone_hmac: before.verify_phone_hmac,
    row_version: before.row_version + 1,
  });
  expect(await f.permissionKeys(a.id)).toEqual(['user.list']);
  await dead(f, own.admin_token);
  await alive(f, f.token);

  const audit = await f.audits('admin_totp_reset');
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ app_id: f.appId, admin_id: f.actor.id });
  expect(text(audit[0])).toContain(a.id);
  expect(text(audit[0])).toContain(reason);
  expect(text(await f.audits())).not.toContain(a.secret);

  f.clock.advanceMs(30_000);
  const next = await login(f, a, 'bind_totp');
  const secret = await binding(f, next.login_ticket);
  expect(secret.totp_secret).not.toBe(a.secret);
  const session = await success<Session>(
    await f.post('/totp/bind', {
      login_ticket: next.login_ticket,
      code: totp(secret.totp_secret, f.clock),
    }),
    '/totp/bind',
  );
  await alive(f, session.admin_token);
}, 30_000);

it.each(['change_password', 'bind_totp'] as const)(
  '[AC-B1-34h#21] 重置前拿到的 %s 凭证在重置后作废',
  async (next) => {
    const f = await setup(h);
    const a =
      next === 'change_password' ? await f.onInitialPassword() : await f.target({ bound: false });
    const pending = await login(f, a, next);
    const pendingSecret =
      next === 'bind_totp' ? (await binding(f, pending.login_ticket)).totp_secret : '';
    await ok(await f.act('reset', a.id), 'reset');
    if (next === 'change_password') {
      ticketGone(
        await f.post('/password', {
          login_ticket: pending.login_ticket,
          new_password: randomBytes(24).toString('base64url'),
        }),
      );
      expect(await verifyAdminPassword(a.password, (await f.row(a.id)).password_hash)).toBe(true);
    } else {
      ticketGone(
        await f.post('/totp/bind', {
          login_ticket: pending.login_ticket,
          code: totp(pendingSecret, f.clock),
        }),
      );
    }
    expect(await f.row(a.id)).toMatchObject({ totp_bound_at: null });
  },
);

it.each([
  ['另一位超管', { isSuper: true }],
  ['停用的账号', { status: 'disabled' }],
  ['未绑定验证器的账号', { bound: false }],
] as const)('[AC-B1-34h#22] 可以重置%s的验证器', async (_label, options) => {
  const f = await setup(h);
  const a = await f.target(options);
  // Only an active, bound account can hold a session to be voided.
  const signedIn = a.expected.status === 'active' && a.expected.totp_bound;
  const own = signedIn ? await signInAgain(f, a) : null;
  const result = await ok<Account>(await f.act('reset', a.id), 'reset');
  expect(result).toMatchObject({
    admin_id: a.id,
    is_super: a.expected.is_super,
    status: a.expected.status,
    totp_bound: false,
  });
  expect(await f.row(a.id)).toMatchObject({ totp_secret_cipher: null, totp_bound_at: null });
  if (own !== null) await dead(f, own.admin_token);
  await alive(f, f.token);
});

it('[AC-B1-34h#23] 超管不能重置自己的验证器：10403，什么都不变，会话仍有效', async () => {
  const f = await setup(h);
  const step = await f.issue();
  const before = await f.snapshot();
  await error(
    await f.send('reset', { token: f.token, id: f.actor.id, body: { reason: '演示' }, step }),
    'reset',
    10403,
    { reason: 'admin_permission_denied' },
  );
  expect(await f.snapshot()).toEqual(before);
  await alive(f, f.token);
});
