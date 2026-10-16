// B1-02d: first and repeated third-party login over the real AppModule (BR-ID-04, AC-S1-67 ①⑮).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ROOT } from '../../risk/signature/kit.ts';
import {
  CONSENT_AT,
  DEVICE_LOG_CONTEXT,
  LEGAL,
  LOGIN,
  accepted,
  column,
  credentials,
  fixture,
  loginBody,
  openOauthKit,
  closeOauthKit,
  portInput,
  rows,
  stored,
  type Fixture,
  type LoginData,
  type OauthKit,
  type Provider,
} from './kit.ts';

let kit: OauthKit;
beforeAll(async () => {
  kit = await openOauthKit();
}, 180_000);
afterAll(async () => {
  await closeOauthKit(kit);
});

async function defaultAvatar(): Promise<string> {
  const registration = (await import(
    new URL('apps/api/src/modules/identity/application/registration.ts', ROOT).href
  )) as typeof import('../../../../apps/api/src/modules/identity/application/registration.ts');
  return registration.registrationConstants().DEFAULT_AVATAR;
}

/** The writes of one successful login for (user, this device), at the kit's Clock instant. */
async function assertLoginWrites(f: Fixture, provider: Provider, data: LoginData) {
  const principal = await f.tokens.verifyAccess(data.tokens.access_token);
  expect(principal).toMatchObject({
    uid: data.user_id,
    app_id: f.appId,
    device_id: f.device.deviceId,
    scp: data.tokens.session_scope,
  });
  const state = await rows(f);
  const session = state.sessions.find((row) => row.sid === principal.sid);
  expect(session).toMatchObject({
    user_id: data.user_id,
    device_id: f.device.deviceId,
    created_at: kit.clock.now(),
    revoked_at: null,
  });
  // D19: the session records how it was opened.
  expect(column(session, 'login_method')).toBe(provider);
  expect(state.refresh.filter((row) => row.sid === principal.sid)).toHaveLength(1);
  const device = await f.db
    .selectFrom('devices')
    .select('last_login_sid')
    .where('id', '=', f.device.deviceId)
    .executeTakeFirstOrThrow();
  expect(device.last_login_sid).toBe(principal.sid);
  const consents = state.consents.filter(
    (row) => row.user_id === data.user_id && row.channel === 'login_page',
  );
  for (const type of ['privacy', 'agreement'] as const) {
    expect(
      consents.filter(
        (row) => row.type === type && row.server_at.getTime() === kit.clock.now().getTime(),
      ),
    ).toEqual([
      expect.objectContaining({
        subject_type: 'user',
        accepted: true,
        version: LEGAL[type],
        client_at: new Date(CONSENT_AT),
        server_at: kit.clock.now(),
      }),
    ]);
  }
  const logs = state.logs.filter(
    (row) => row.user_id === data.user_id && row.created_at.getTime() === kit.clock.now().getTime(),
  );
  expect(logs).toEqual([
    expect.objectContaining({
      method: provider,
      device_id_hash: f.crypto.blindIndex(f.device.deviceId, DEVICE_LOG_CONTEXT),
      device_hash: f.device.deviceHash,
    }),
  ]);
  expect(logs[0]!.device_id_hash).not.toBe(f.device.deviceId);
  return principal;
}

it.each(['wechat', 'apple'] as const)(
  '[AC-B1-02d#1][AC-S1-67#1][BR-ID-04] %s 首次登录建号：union_id 取换取结果、默认资料、两条同意、登录日志与会话',
  async (provider) => {
    const f = await fixture(kit);
    const unionId = `union-${randomUUID()}`;
    const openId = `open-${randomUUID()}`;
    kit.exchange.mockResolvedValue(
      provider === 'wechat'
        ? { union_id: unionId, open_id: openId }
        : { union_id: unionId, apple_refresh_token: `apple-refresh-${randomUUID()}` },
    );
    const pushId = await f.pushToken();
    const attempt = await f.device.attempt(provider);
    const body = loginBody(provider, attempt.attempt_id);
    const data = accepted(kit, LOGIN[provider], await f.device.post(LOGIN[provider], body));
    expect(data).toMatchObject({ is_new_user: true, tokens: { session_scope: 'full' } });
    expect(data).not.toHaveProperty('invite_bind');
    expect(kit.exchange).toHaveBeenCalledExactlyOnceWith(portInput(provider, body, attempt.nonce));
    const state = await rows(f);
    expect(state.users).toHaveLength(1);
    const user = state.users[0]!;
    expect(user).toMatchObject({
      id: data.user_id,
      nickname: `用户${data.user_id.slice(-4)}`,
      avatar: await defaultAvatar(),
      status: 'normal',
      register_method: provider,
      registered_channel: 'appstore',
      phone_hmac: null,
      phone_cipher: null,
    });
    expect(state.oauth).toEqual([
      expect.objectContaining({
        user_id: data.user_id,
        provider,
        union_id: unionId,
        open_id: provider === 'wechat' ? openId : null,
        merged_from_user_id: null,
      }),
    ]);
    expect(state.registrations).toEqual([
      expect.objectContaining({
        user_id: data.user_id,
        device_hash: f.device.deviceHash,
        register_method: provider,
      }),
    ]);
    const principal = await assertLoginWrites(f, provider, data);
    // BR-ID-07 细则「登录时绑定」: the device's push token follows the new session.
    expect(
      await f.db
        .selectFrom('push_tokens')
        .selectAll()
        .where('id', '=', pushId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ user_id: data.user_id, bound_sid: principal.sid });
  },
);

it.each(['wechat', 'apple'] as const)(
  '[AC-B1-02d#2][AC-S1-67#1][BR-ID-04] %s 再次登录进入同一账号，is_new_user=false，不再建号或计注册',
  async (provider) => {
    const f = await fixture(kit);
    const unionId = `union-${randomUUID()}`;
    kit.exchange.mockResolvedValue({ union_id: unionId });
    const first = await f.device.attempt(provider);
    const created = accepted(
      kit,
      LOGIN[provider],
      await f.device.post(LOGIN[provider], loginBody(provider, first.attempt_id)),
    );
    expect(created.is_new_user).toBe(true);
    kit.clock.advanceMs(60_000);
    const second = await f.device.attempt(provider);
    const again = accepted(
      kit,
      LOGIN[provider],
      await f.device.post(LOGIN[provider], loginBody(provider, second.attempt_id)),
    );
    expect(again).toMatchObject({
      user_id: created.user_id,
      is_new_user: false,
      tokens: { session_scope: 'full' },
    });
    expect(again.tokens.access_token).not.toBe(created.tokens.access_token);
    await assertLoginWrites(f, provider, again);
    const state = await rows(f);
    expect(state.users).toHaveLength(1);
    expect(state.oauth).toHaveLength(1);
    expect(state.registrations).toHaveLength(1);
    expect(state.sessions).toHaveLength(2);
    expect(state.logs).toHaveLength(2);
    expect(state.consents.filter((row) => row.channel === 'login_page')).toHaveLength(4);
  },
);

it('[AC-B1-02d#3][BR-ID-04] 同一第三方身份在不同 provider 下是不同账号；已有账号按 (provider, union_id) 查找', async () => {
  const f = await fixture(kit);
  const bound = await f.account('wechat');
  // The same identifier under another provider is another identity.
  kit.exchange.mockResolvedValue({ union_id: bound.unionId });
  const apple = await f.device.attempt('apple');
  const created = accepted(
    kit,
    LOGIN.apple,
    await f.device.post(LOGIN.apple, loginBody('apple', apple.attempt_id)),
  );
  expect(created.is_new_user).toBe(true);
  expect(created.user_id).not.toBe(bound.uid);
  const wechat = await f.device.attempt('wechat');
  const existing = accepted(
    kit,
    LOGIN.wechat,
    await f.device.post(LOGIN.wechat, loginBody('wechat', wechat.attempt_id)),
  );
  expect(existing).toMatchObject({ user_id: bound.uid, is_new_user: false });
});

it.each(['wechat', 'apple'] as const)(
  '[AC-B1-02d#4][AC-S1-67#15][BR-ID-04] %s 凭证、nonce 与令牌不落库、不进日志',
  async (provider) => {
    const f = await fixture(kit);
    const refresh = `apple-refresh-${randomUUID()}`;
    kit.exchange.mockResolvedValue({
      union_id: `union-${randomUUID()}`,
      ...(provider === 'apple' ? { apple_refresh_token: refresh } : {}),
    });
    const start = kit.lines.length;
    const given = credentials(provider);
    const attempt = await f.device.attempt(provider);
    const data = accepted(
      kit,
      LOGIN[provider],
      await f.device.post(LOGIN[provider], loginBody(provider, attempt.attempt_id, given)),
    );
    const secrets = [
      ...Object.values(given),
      attempt.nonce,
      data.tokens.access_token,
      data.tokens.refresh_token,
      ...(provider === 'apple' ? [refresh] : []),
    ];
    const logged = kit.lines.slice(start).join('\n');
    const written = await stored(f);
    for (const secret of secrets) {
      expect(logged).not.toContain(secret);
      expect(written).not.toContain(secret);
    }
  },
);
