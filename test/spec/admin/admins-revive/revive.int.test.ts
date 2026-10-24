import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { ok } from '../admins-write/kit.ts';
import {
  alive,
  binding,
  dead,
  harness,
  login,
  raced,
  setup,
  signInAgain,
  success,
  totp,
  WINDOWS,
  type Session,
} from './kit.ts';

// B1-34h r2 S2: a session issued in the narrow window of a disable or an authenticator reset
// survives the voiding instant (iat is whole seconds) and is refused only for the account's state.
// Enabling the account and its first authenticator binding after the reset also void what was
// issued before them, so that session never comes back. Before the fix the revived session still
// passes the admin check: the dead() after the enable / the binding fails its status assertion.
const h = harness(createTestDatabase, acquireTestRedis);

it.each(WINDOWS)(
  '[AC-B1-34n#1] 停用与登录最后一步交错（%s）：停用期间被拒的会话在启用后仍 10001，启用后重新登录可用',
  async (_label, voidMs, issueMs) => {
    const f = await setup(h);
    const a = await f.target();
    const bystander = await signInAgain(f, await f.target());
    const session = await raced(h, f, a, 'disable', voidMs, issueMs);
    await dead(f, session.admin_token);

    await ok(await f.act('enable', a.id), 'enable');
    expect(await f.row(a.id)).toMatchObject({ status: 'active' });
    await dead(f, session.admin_token);

    const fresh = await signInAgain(f, a);
    await alive(f, fresh.admin_token);
    await dead(f, session.admin_token);
    await alive(f, f.token);
    await alive(f, bystander.admin_token);
  },
  30_000,
);

it.each(WINDOWS)(
  '[AC-B1-34n#2] 重置验证器与登录最后一步交错（%s）：首次重绑后旧会话仍 10001，绑定得到的会话与之后的登录可用',
  async (_label, voidMs, issueMs) => {
    const f = await setup(h);
    const a = await f.target();
    const bystander = await signInAgain(f, await f.target());
    const session = await raced(h, f, a, 'reset', voidMs, issueMs);
    await dead(f, session.admin_token);

    f.clock.advanceMs(30_000);
    const next = await login(f, a, 'bind_totp');
    const secret = (await binding(f, next.login_ticket)).totp_secret;
    expect(secret).not.toBe(a.secret);
    const bound = await success<Session>(
      await f.post('/totp/bind', { login_ticket: next.login_ticket, code: totp(secret, f.clock) }),
      '/totp/bind',
    );
    expect((await f.row(a.id)).totp_bound_at).not.toBeNull();
    await dead(f, session.admin_token);
    await alive(f, bound.admin_token);

    const fresh = await signInAgain(f, { ...a, secret });
    await alive(f, fresh.admin_token);
    await alive(f, bound.admin_token);
    await dead(f, session.admin_token);
    await alive(f, f.token);
    await alive(f, bystander.admin_token);
  },
  30_000,
);
