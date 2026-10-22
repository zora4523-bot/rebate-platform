import { expect, it } from 'vitest';
import { SiteReauthError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  ACCESS,
  CODE,
  PROVIDER_EXPIRY,
  REFRESH,
  TTL,
  account,
  audits,
  credentials,
  databaseFixture,
  expectNoSecrets,
  harness,
  seed,
  seedCredential,
  session,
  snapshot,
  start,
  startInput,
} from './kit.ts';

const db = databaseFixture();

it('[AC-B1-22c#20] 换码中的已用会话跨过到期时间，巡检与结果读取不将它过期，换码仍能成功', async () => {
  const h = await harness(db());
  const a = await seed(h);
  const old = await seedCredential(h, a.id);
  const s = await start(h, a.id);
  const unused = await start(h, a.id);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.exchange.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: PROVIDER_EXPIRY };
  });
  const claimedAt = h.clock.now();
  const callback = h.service.callback({ state: s.state, code: CODE, error: null });
  try {
    await Promise.race([entered.promise, callback]);
    const claimed = await session(h, s.sessionId);
    expect(claimed).toMatchObject({
      status: 'pending',
      used_at: claimedAt,
      finished_at: null,
    });
    h.clock.advanceMs(TTL + 1);
    expect(await h.service.expireStale()).toBe(1);
    expect((await session(h, unused.sessionId)).status).toBe('expired');
    expect(await session(h, s.sessionId)).toEqual(claimed);
    expect(
      await h.service.result({ appId: h.appId, unionAccountId: a.id, sessionId: s.sessionId }),
    ).toEqual({ status: 'pending', error: null, finishedAt: null });
    expect(await session(h, s.sessionId)).toEqual(claimed);
    expect(await account(h, a.id)).toEqual(a);
    expect(await credentials(h)).toEqual([old]);
  } finally {
    // Always release and drain the callback before the fixture database is dropped.
    release.resolve();
    await callback;
  }
  expect(await callback).toEqual({ sessionId: s.sessionId, status: 'succeeded' });
  expect(await session(h, s.sessionId)).toMatchObject({
    status: 'succeeded',
    error: null,
    used_at: claimedAt,
    finished_at: h.clock.now(),
  });
  expect(await account(h, a.id)).toMatchObject({
    auth_expires_at: PROVIDER_EXPIRY,
    auth_expires_estimated: false,
    auth_renewed_at: h.clock.now(),
    auth_renewed_by: h.adminId,
    auth_status: 'active',
    alert_stage: 'none',
    row_version: a.row_version + 1,
  });
  const rows = await credentials(h);
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.id === old.id)).toMatchObject({ is_current: false });
  const current = rows.filter((row) => row.is_current);
  expect(current).toHaveLength(1);
  expect(current[0]!.id).not.toBe(old.id);
  expect(current[0]!.expires_at).toEqual(PROVIDER_EXPIRY);
  expect(
    h.crypto.decrypt(current[0]!.access_token_cipher.toString(), 'union_credentials.access'),
  ).toBe(ACCESS);
  expect(current[0]!.refresh_token_cipher).not.toBeNull();
  expect(
    h.crypto.decrypt(current[0]!.refresh_token_cipher!.toString(), 'union_credentials.refresh'),
  ).toBe(REFRESH);
  expect(h.exchange).toHaveBeenCalledExactlyOnceWith({
    appId: h.appId,
    unionAccountId: a.id,
    code: CODE,
  });
});

for (const [platform, code] of [
  ['jd', 'reauth_manual'],
  ['pdd', 'reauth_unsupported'],
] as const) {
  it(`[AC-B1-22c#21] 不覆盖 modes，${platform} 发起返回 ${code} 且不落任何行`, async () => {
    const h = await harness(db());
    h.configValue.mockResolvedValue({ value: 'private_position', version: 1 });
    const a = await seed(h, { platform });
    const before = await snapshot(h);
    const error: unknown = await h.service
      .start(startInput(h, a.id))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SiteReauthError);
    expect(error).toMatchObject({ code });
    expect(await snapshot(h)).toEqual(before);
    expect(h.authorizeUrl).not.toHaveBeenCalled();
    expect(h.exchange).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
    if (platform === 'jd') {
      expect(h.configValue).toHaveBeenCalledWith(h.appId, 'attr.jd.user_key_mode');
    }
  });
}

it('[AC-B1-22c#22] 成功审计失败时，回调错误的 message 与 stack 均不泄露敏感值', async () => {
  const h = await harness(db());
  const a = await seed(h);
  await seedCredential(h, a.id);
  const s = await start(h, a.id);
  const beforeCredentials = await credentials(h);
  const beforeAudits = await audits(h);
  h.append.mockClear();
  h.append.mockRejectedValue(new Error('synthetic audit unavailable'));
  const outcome = await h.service.callback({ state: s.state, code: CODE, error: null }).then(
    (value) => ({ kind: 'returned' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );
  const secrets = [ACCESS, REFRESH, CODE, s.state, s.authUrl];
  if (outcome.kind === 'rejected') {
    // Error.message and Error.stack are non-enumerable: serialize them explicitly.
    if (outcome.error instanceof Error) {
      expectNoSecrets({ message: outcome.error.message, stack: outcome.error.stack }, secrets);
    } else {
      expectNoSecrets({ error: outcome.error }, secrets);
    }
  } else {
    expect(outcome.value.status).toBe('failed');
    expectNoSecrets(outcome.value, secrets);
  }
  expect(h.exchange).toHaveBeenCalledOnce();
  expect(h.append.mock.calls.some(([, input]) => input.action === 'union.reauth_succeeded')).toBe(
    true,
  );
  expect(await account(h, a.id)).toEqual(a);
  expect(await credentials(h)).toEqual(beforeCredentials);
  expect(await audits(h)).toEqual(beforeAudits);
  expect((await session(h, s.sessionId)).status).not.toBe('succeeded');
});
