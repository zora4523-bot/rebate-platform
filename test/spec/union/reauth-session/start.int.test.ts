import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  createSiteReauth,
  SiteReauthError,
  type ReauthMode,
  type RegisteredPlatform,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  START,
  TTL,
  account,
  audits,
  databaseFixture,
  expectNoSecrets,
  harness,
  hash,
  seed,
  session,
  snapshot,
  start,
  startInput,
} from './kit.ts';

const db = databaseFixture();

it('[AC-B1-22c#1] 默认平台登记：淘宝 OAuth、拼多多 none；读取 mode 不落库', async () => {
  const h = await harness(db());
  const before = await snapshot(h);
  expect(await h.service.reauthMode(h.appId, 'taobao')).toBe('oauth');
  expect(await h.service.reauthMode(h.appId, 'pdd')).toBe('none');
  expect(await snapshot(h)).toEqual(before);
});

for (const [value, mode] of [
  ['private_position', 'manual'],
  ['sub_union_id', 'none'],
  ['claim_only', 'none'],
  ['unknown', 'none'],
  [null, 'none'],
  [42, 'none'],
  [{ mode: 'private_position' }, 'none'],
] as const) {
  it(`[AC-B1-22c#2] 京东配置 ${JSON.stringify(value)} 派生 ${mode} 并按 app 读取`, async () => {
    const h = await harness(db());
    h.configValue.mockImplementation(async (appId) =>
      appId === h.appId ? { value, version: 1 } : null,
    );
    expect(await h.service.reauthMode(h.appId, 'jd')).toBe(mode);
    expect(h.configValue).toHaveBeenCalledWith(h.appId, 'attr.jd.user_key_mode');
    expect(await h.service.reauthMode(`${h.appId}-other`, 'jd')).toBe('none');
  });
}

it('[AC-B1-22c#3] 京东配置不存在时为 none', async () => {
  const h = await harness(db());
  expect(await h.service.reauthMode(h.appId, 'jd')).toBe('none');
  expect(h.configValue).toHaveBeenCalledWith(h.appId, 'attr.jd.user_key_mode');
});

for (const platform of ['taobao', 'jd', 'pdd'] as const) {
  for (const mode of ['oauth', 'manual', 'none'] as const) {
    it(`[AC-B1-22c#4] 登记覆盖 ${platform}=${mode} 优先于默认与京东配置`, async () => {
      const h = await harness(db(), { modes: { [platform]: mode } });
      h.configValue.mockResolvedValue({ value: 'private_position', version: 1 });
      expect(await h.service.reauthMode(h.appId, platform)).toBe(mode);
    });
  }
}

for (const scenario of ['missing', 'other-app', 'none', 'manual', 'provider'] as const) {
  it(`[AC-B1-22c#5] start 拒绝 ${scenario}，无会话、审计或其他写入`, async () => {
    const modes: Partial<Record<RegisteredPlatform, ReauthMode>> =
      scenario === 'none' ? { taobao: 'none' } : scenario === 'manual' ? { taobao: 'manual' } : {};
    const h = await harness(db(), { modes, ...(scenario === 'provider' ? { oauth: {} } : {}) });
    const a = await seed(h);
    const foreign = await seed(h, { app_id: `${h.appId}-other` });
    const input = startInput(
      h,
      scenario === 'missing' ? randomUUID() : scenario === 'other-app' ? foreign.id : a.id,
    );
    const before = await snapshot(h);
    const expectedCode =
      scenario === 'none'
        ? 'reauth_unsupported'
        : scenario === 'manual'
          ? 'reauth_manual'
          : scenario === 'provider'
            ? 'provider_missing'
            : 'account_not_found';
    const error: unknown = await h.service.start(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SiteReauthError);
    expect(error).toMatchObject({ code: expectedCode });
    expect(await snapshot(h)).toEqual(before);
    expect(await account(h, foreign.id)).toEqual(foreign);
    expect(h.authorizeUrl).not.toHaveBeenCalled();
    expect(h.exchange).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });
}

it('[AC-B1-22c#6] start 以 32 字节随机 state 建会话，只存 SHA-256，授权地址有效期同为 10 分钟', async () => {
  const h = await harness(db());
  const a = await seed(h);
  const s = await start(h, a.id);
  expect(h.entropy).toHaveBeenCalledExactlyOnceWith(32);
  const entropy = h.entropy.mock.results[0]!.value as Buffer;
  expect(s.state).toBe(entropy.toString('base64url'));
  expect(s.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const expiresAt = new Date(Date.parse(START) + TTL);
  expect(s.expiresAt).toEqual(expiresAt);
  expect(s.authUrl).toBe(`https://oauth.example.invalid/authorize?state=${s.state}`);
  expect(h.authorizeUrl).toHaveBeenCalledExactlyOnceWith({
    appId: h.appId,
    unionAccountId: a.id,
    state: s.state,
    expiresAt,
  });
  const row = await session(h, s.sessionId);
  expect(row).toMatchObject({
    app_id: h.appId,
    union_account_id: a.id,
    created_by: h.adminId,
    state_hash: hash(s.state),
    status: 'pending',
    error: null,
    used_at: null,
    finished_at: null,
    created_at: h.clock.now(),
    expires_at: expiresAt,
  });
  expect(row.state_hash.length).toBe(32);
  expectNoSecrets(await snapshot(h), [s.state, s.authUrl]);
  expect(
    await h.service.result({ appId: h.appId, unionAccountId: a.id, sessionId: s.sessionId }),
  ).toEqual({ status: 'pending', error: null, finishedAt: null });
  const rows = await audits(h);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    app_id: h.appId,
    admin_id: h.adminId,
    action: 'union.reauth_start',
    target: a.id,
    after: { session_id: s.sessionId, reason: startInput(h, a.id).reason },
    ip: '192.0.2.7',
  });
  expect(h.exchange).not.toHaveBeenCalled();
});

it('[AC-B1-22c#7] 提前重新授权可并存多个 pending，会话 id 与默认随机 state 各不相同', async () => {
  const h = await harness(db());
  const options = { ...h.options };
  delete options.randomBytes;
  const service = createSiteReauth(options);
  const a = await seed(h, {
    auth_status: 'active',
    auth_expires_at: new Date('2032-12-01T00:00:00Z'),
  });
  const first = await service.start({ ...startInput(h, a.id), reason: null });
  const second = await service.start({ ...startInput(h, a.id), reason: null });
  expect(first.sessionId).not.toBe(second.sessionId);
  const states = h.authorizeUrl.mock.calls.map(([input]) => input.state);
  expect(states).toHaveLength(2);
  expect(new Set(states).size).toBe(2);
  for (const state of states) expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const rows = (await snapshot(h)).sessions;
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.status === 'pending')).toBe(true);
  expect((await audits(h)).map((row) => row.action)).toEqual([
    'union.reauth_start',
    'union.reauth_start',
  ]);
  expect(
    await service.callback({ state: states[0]!, code: 'early-renewal-code', error: null }),
  ).toEqual({ sessionId: first.sessionId, status: 'succeeded' });
  expect((await session(h, second.sessionId)).status).toBe('pending');
});

it('[AC-B1-22c#8] 审计写入失败，发起会话的事务回滚', async () => {
  const h = await harness(db());
  const a = await seed(h);
  const before = await snapshot(h);
  h.append.mockRejectedValue(new Error('synthetic audit unavailable'));
  await expect(h.service.start(startInput(h, a.id))).rejects.toThrow();
  expect(h.append).toHaveBeenCalledOnce();
  expect(await snapshot(h)).toEqual(before);
});

for (const platform of ['jd', 'pdd'] as const) {
  it(`[AC-B1-22c#9] 显式登记 ${platform}=oauth 后使用该平台端口`, async () => {
    const h = await harness(db(), { modes: { [platform]: 'oauth' } });
    const service = createSiteReauth({
      ...h.options,
      oauth: { [platform]: { authorizeUrl: h.authorizeUrl, exchange: h.exchange } },
    });
    const a = await seed(h, { platform });
    const s = await service.start(startInput(h, a.id));
    expect((await session(h, s.sessionId)).union_account_id).toBe(a.id);
    expect(h.authorizeUrl).toHaveBeenCalledOnce();
    const state = h.authorizeUrl.mock.calls[0]![0].state;
    expect(await service.callback({ state, code: 'synthetic-code', error: null })).toEqual({
      sessionId: s.sessionId,
      status: 'succeeded',
    });
    expect(h.exchange).toHaveBeenCalledExactlyOnceWith({
      appId: h.appId,
      unionAccountId: a.id,
      code: 'synthetic-code',
    });
  });
}
