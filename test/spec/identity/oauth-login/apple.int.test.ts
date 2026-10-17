// B1-02d: the Apple refresh token of Sign in with Apple (BR-ID-04 正文与细则「Apple」「Apple 撤销授权」;
// AC-S1-67 ⑮): stored encrypted at every Apple login, replaced by the latest exchange, and a
// re-authorization of a revoked binding logs in the same account.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  APPLE_REFRESH_CONTEXT,
  ATTEMPTS,
  LOGIN,
  accepted,
  column,
  credentials,
  fixture,
  issueSession,
  loginBody,
  openOauthKit,
  closeOauthKit,
  rows,
  type Fixture,
  type OauthKit,
} from './kit.ts';

let kit: OauthKit;
beforeAll(async () => {
  kit = await openOauthKit();
}, 180_000);
afterAll(async () => {
  await closeOauthKit(kit);
});

async function appleLogin(f: Fixture, unionId: string, refresh: string) {
  kit.exchange.mockResolvedValue({ union_id: unionId, apple_refresh_token: refresh });
  const attempt = await f.device.attempt('apple');
  return accepted(
    kit,
    LOGIN.apple,
    await f.device.post(LOGIN.apple, loginBody('apple', attempt.attempt_id)),
  );
}
async function binding(f: Fixture, uid: string) {
  return f.db
    .selectFrom('user_oauth')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('user_id', '=', uid)
    .where('provider', '=', 'apple')
    .executeTakeFirst();
}
function plaintextOf(f: Fixture, row: object | undefined): string {
  const cipher = column(row, 'apple_refresh_token_cipher');
  expect(Buffer.isBuffer(cipher)).toBe(true);
  return f.crypto.decrypt((cipher as Buffer).toString('utf8'), APPLE_REFRESH_CONTEXT);
}

it('[AC-B1-02d#21][AC-S1-67#15][BR-ID-04] Apple 首次登录把换码所得 refresh_token 加密存入 user_oauth，密文不含明文', async () => {
  const f = await fixture(kit);
  const refresh = `apple-refresh-${randomUUID()}`;
  const data = await appleLogin(f, `sub-${randomUUID()}`, refresh);
  const row = await binding(f, data.user_id);
  const cipher = column(row, 'apple_refresh_token_cipher') as Buffer;
  expect(Buffer.isBuffer(cipher)).toBe(true);
  expect(cipher.toString('utf8')).not.toContain(refresh);
  expect(cipher.includes(Buffer.from(refresh, 'utf8'))).toBe(false);
  expect(plaintextOf(f, row)).toBe(refresh);
  expect(column(row, 'revoked_at')).toBeNull();
});

it('[AC-B1-02d#22][BR-ID-04] Apple 再次登录用本次换码所得替换旧 refresh_token', async () => {
  const f = await fixture(kit);
  const sub = `sub-${randomUUID()}`;
  const first = await appleLogin(f, sub, `apple-refresh-${randomUUID()}`);
  kit.clock.advanceMs(60_000);
  const latest = `apple-refresh-${randomUUID()}`;
  const again = await appleLogin(f, sub, latest);
  expect(again).toMatchObject({ user_id: first.user_id, is_new_user: false });
  expect(plaintextOf(f, await binding(f, first.user_id))).toBe(latest);
  expect((await rows(f)).oauth).toHaveLength(1);
});

it('[AC-B1-02d#23][BR-ID-04] 已撤销授权的 Apple 绑定重新授权：登录原账号、清空 revoked_at、换存新 refresh_token', async () => {
  const f = await fixture(kit);
  const sub = `sub-${randomUUID()}`;
  const first = await appleLogin(f, sub, `apple-refresh-${randomUUID()}`);
  // Columns of migration 0033 (B1-02w): written by name, after the route answered.
  await sql`UPDATE app.user_oauth SET revoked_at = ${kit.clock.now()}, apple_refresh_token_cipher = NULL
    WHERE app_id = ${f.appId} AND user_id = ${first.user_id} AND provider = 'apple'`.execute(
    kit.suite.db,
  );
  kit.clock.advanceMs(60_000);
  const fresh = `apple-refresh-${randomUUID()}`;
  const again = await appleLogin(f, sub, fresh);
  expect(again).toMatchObject({ user_id: first.user_id, is_new_user: false });
  const row = await binding(f, first.user_id);
  expect(column(row, 'revoked_at')).toBeNull();
  expect(plaintextOf(f, row)).toBe(fresh);
  const state = await rows(f);
  expect(state.users).toHaveLength(1);
  expect(state.oauth).toHaveLength(1);
});

it('[AC-B1-02d#24][BR-ID-04] 微信登录不写 Apple refresh_token 列', async () => {
  const f = await fixture(kit);
  kit.exchange.mockResolvedValue({
    union_id: `union-${randomUUID()}`,
    open_id: `open-${randomUUID()}`,
  });
  const attempt = await f.device.attempt('wechat');
  const data = accepted(
    kit,
    LOGIN.wechat,
    await f.device.post(LOGIN.wechat, loginBody('wechat', attempt.attempt_id)),
  );
  const row = await f.db
    .selectFrom('user_oauth')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('user_id', '=', data.user_id)
    .executeTakeFirst();
  expect(row).toBeDefined();
  expect(column(row, 'apple_refresh_token_cipher')).toBeNull();
  expect(column(row, 'revoked_at')).toBeNull();
});

it('[AC-B1-02d#35][BR-ID-08] Apple 重新授权的二次验证同样加密保存并替换旧 refresh_token', async () => {
  const f = await fixture(kit);
  const bound = await f.account('apple');
  const session = await issueSession(f, bound.uid);
  const authorization = { authorization: `Bearer ${session.access_token}` };
  const issued = await f.device.post(
    ATTEMPTS,
    { provider: 'apple', purpose: 'step_up', action: 'account_deletion' },
    authorization,
  );
  expect(issued.json()).toMatchObject({ code: 0 });
  const attempt = issued.json<{ data: { attempt_id: string } }>().data;
  const refresh = `apple-refresh-${randomUUID()}`;
  kit.exchange.mockResolvedValue({ union_id: bound.unionId, apple_refresh_token: refresh });
  const response = await f.device.post(
    '/v1/auth/step-up',
    {
      action: 'account_deletion',
      provider: 'apple',
      attempt_id: attempt.attempt_id,
      ...credentials('apple'),
    },
    authorization,
  );
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: { step_up_token: expect.any(String) } });
  expect(plaintextOf(f, await binding(f, bound.uid))).toBe(refresh);
});
