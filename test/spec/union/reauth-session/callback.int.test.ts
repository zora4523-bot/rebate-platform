import { expect, it } from 'vitest';
import { createTestDatabase } from '@couli/db/testing';
import { createSiteReauth } from '../../../../apps/api/src/modules/union/index.ts';
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
} from './kit.ts';

const db = databaseFixture(createTestDatabase);

for (const estimated of [false, true]) {
  for (const refreshToken of [REFRESH, null]) {
    it(`[AC-B1-22c#10] 成功换写加密凭据与账号，到期估算=${estimated}、refresh=${refreshToken !== null}`, async () => {
      const h = await harness(db());
      const a = await seed(h, {
        auth_status: estimated ? 'expiring' : 'expired',
        alert_stage: estimated ? 'd30' : 'expired',
      });
      const old = await seedCredential(h, a.id);
      const other = await seed(h);
      await seedCredential(h, other.id);
      const foreign = await seed(h, { app_id: `${h.appId}-foreign` });
      const beforeCredentials = await credentials(h);
      const s = await start(h, a.id);
      h.clock.advanceMs(5 * 60 * 1000);
      h.exchange.mockResolvedValue({
        accessToken: ACCESS,
        refreshToken,
        expiresAt: estimated ? null : PROVIDER_EXPIRY,
      });
      const now = h.clock.now();
      const expiresAt = estimated
        ? new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
        : PROVIDER_EXPIRY;
      expect(await h.service.callback({ state: s.state, code: CODE, error: null })).toEqual({
        sessionId: s.sessionId,
        status: 'succeeded',
      });
      expect(h.exchange).toHaveBeenCalledExactlyOnceWith({
        appId: h.appId,
        unionAccountId: a.id,
        code: CODE,
      });
      const rows = await credentials(h);
      const own = rows.filter((row) => row.union_account_id === a.id);
      expect(own).toHaveLength(2);
      expect(own.find((row) => row.id === old.id)).toMatchObject({
        ...old,
        is_current: false,
        updated_at: expect.any(Date),
      });
      const current = own.filter((row) => row.is_current);
      expect(current).toHaveLength(1);
      const credential = current[0]!;
      expect(credential).toMatchObject({ app_id: h.appId, expires_at: expiresAt, created_at: now });
      expect(credential.id).not.toBe(old.id);
      expect(Buffer.isBuffer(credential.access_token_cipher)).toBe(true);
      expect(
        h.crypto.decrypt(credential.access_token_cipher.toString(), 'union_credentials.access'),
      ).toBe(ACCESS);
      if (refreshToken === null) {
        expect(credential.refresh_token_cipher).toBeNull();
      } else {
        expect(credential.refresh_token_cipher).not.toBeNull();
        expect(
          h.crypto.decrypt(
            credential.refresh_token_cipher!.toString(),
            'union_credentials.refresh',
          ),
        ).toBe(REFRESH);
      }
      expect(await account(h, a.id)).toEqual({
        ...a,
        auth_expires_at: expiresAt,
        auth_expires_estimated: estimated,
        auth_renewed_at: now,
        auth_renewed_by: h.adminId,
        auth_status: 'active',
        alert_stage: 'none',
        row_version: a.row_version + 1,
        updated_at: expect.any(Date),
      });
      expect(await account(h, other.id)).toEqual(other);
      expect(await account(h, foreign.id)).toEqual(foreign);
      expect(rows.filter((row) => row.union_account_id === other.id)).toEqual(
        beforeCredentials.filter((row) => row.union_account_id === other.id),
      );
      expect(await session(h, s.sessionId)).toMatchObject({
        status: 'succeeded',
        error: null,
        used_at: now,
        finished_at: now,
      });
      expect(
        await h.service.result({ appId: h.appId, unionAccountId: a.id, sessionId: s.sessionId }),
      ).toEqual({ status: 'succeeded', error: null, finishedAt: now });
      const audit = await audits(h);
      expect(audit).toHaveLength(2);
      const succeeded = audit.find((row) => row.action === 'union.reauth_succeeded');
      expect(succeeded).toMatchObject({
        app_id: h.appId,
        admin_id: h.adminId,
        target: a.id,
        before: {
          auth_expires_at: a.auth_expires_at!.toISOString(),
          auth_status: a.auth_status,
          alert_stage: a.alert_stage,
          auth_expires_estimated: true,
        },
        after: {
          auth_expires_at: expiresAt.toISOString(),
          auth_status: 'active',
          alert_stage: 'none',
          auth_expires_estimated: estimated,
        },
      });
      for (const payload of [succeeded!.before, succeeded!.after]) {
        expect(Object.keys(payload as object).sort()).toEqual([
          'alert_stage',
          'auth_expires_at',
          'auth_expires_estimated',
          'auth_status',
        ]);
      }
      expectNoSecrets(await snapshot(h), [ACCESS, REFRESH, CODE, s.state, s.authUrl]);
      expectNoSecrets(
        h.append.mock.calls.map(([, input]) => input),
        [ACCESS, REFRESH, CODE, s.state, s.authUrl],
      );
    });
  }
}

for (const elapsed of [TTL - 1000, TTL, TTL + 1]) {
  it(`[AC-B1-22c#11] 回调 ${elapsed}ms：9:59 可用，10:00 起过期且不换码`, async () => {
    const h = await harness(db());
    const a = await seed(h);
    await seedCredential(h, a.id);
    const s = await start(h, a.id);
    const before = await credentials(h);
    h.clock.advanceMs(elapsed);
    const expired = elapsed >= TTL;
    expect(
      await h.service.callback({
        state: s.state,
        code: CODE,
        error: elapsed > TTL ? 'access_denied' : null,
      }),
    ).toEqual({
      sessionId: s.sessionId,
      status: expired ? 'expired' : 'succeeded',
    });
    expect(h.exchange).toHaveBeenCalledTimes(expired ? 0 : 1);
    expect(await session(h, s.sessionId)).toMatchObject({
      status: expired ? 'expired' : 'succeeded',
      finished_at: h.clock.now(),
      used_at: expired ? null : h.clock.now(),
    });
    if (expired) {
      expect(await account(h, a.id)).toEqual(a);
      expect(await credentials(h)).toEqual(before);
      expect(await audits(h)).toHaveLength(1);
    }
  });
}

for (const outcome of ['succeeded', 'failed', 'expired'] as const) {
  it(`[AC-B1-22c#12] ${outcome} 会话重复回调 invalid，所有行与换码次数保持不变`, async () => {
    const h = await harness(db());
    const a = await seed(h);
    const s = await start(h, a.id);
    if (outcome === 'expired') h.clock.advanceMs(TTL);
    expect(
      await h.service.callback({
        state: s.state,
        code: CODE,
        error: outcome === 'failed' ? 'access_denied' : null,
      }),
    ).toEqual({ sessionId: s.sessionId, status: outcome });
    const before = await snapshot(h);
    const calls = h.exchange.mock.calls.length;
    h.clock.advanceMs(1);
    expect(
      await h.service.callback({ state: s.state, code: 'another-code', error: null }),
    ).toMatchObject({ status: 'invalid' });
    expect(await snapshot(h)).toEqual(before);
    expect(h.exchange).toHaveBeenCalledTimes(calls);
  });
}

it('[AC-B1-22c#13] 两个服务实例并发消费同一 state，只有一次换码、凭据更新和成功审计', async () => {
  const h = await harness(db());
  const a = await seed(h);
  await seedCredential(h, a.id);
  const s = await start(h, a.id);
  const second = createSiteReauth(h.options);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.exchange.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: PROVIDER_EXPIRY };
  });
  const input = { state: s.state, code: CODE, error: null };
  const callbacks = Promise.all([h.service.callback(input), second.callback(input)]);
  // A rejection also releases the barrier, avoiding leaked pending callbacks on failures.
  try {
    await Promise.race([entered.promise, callbacks]);
  } finally {
    release.resolve();
  }
  const results = await callbacks;
  expect(results.map((result) => result.status).sort()).toEqual(['invalid', 'succeeded']);
  expect(h.exchange).toHaveBeenCalledOnce();
  expect(await credentials(h)).toHaveLength(2);
  expect((await credentials(h)).filter((row) => row.is_current)).toHaveLength(1);
  expect((await account(h, a.id)).row_version).toBe(a.row_version + 1);
  expect((await audits(h)).filter((row) => row.action === 'union.reauth_succeeded')).toHaveLength(
    1,
  );
});

for (const failure of [
  'denied',
  'missing-code',
  'long-error',
  'exchange',
  'exchange-string',
] as const) {
  it(`[AC-B1-22c#14] ${failure} 记 failed 与原因，不改变账号或凭据，失败也是单次消费`, async () => {
    const h = await harness(db());
    const a = await seed(h);
    await seedCredential(h, a.id);
    const s = await start(h, a.id);
    const beforeCredentials = await credentials(h);
    const rawExchangeError = `upstream secret ${ACCESS} ${REFRESH} ${CODE} ${s.state}`;
    const exchangeFailed = failure === 'exchange' || failure === 'exchange-string';
    if (failure === 'exchange') h.exchange.mockRejectedValue(new Error(rawExchangeError));
    if (failure === 'exchange-string') h.exchange.mockRejectedValue(rawExchangeError);
    const error =
      failure === 'denied' ? 'access_denied' : failure === 'long-error' ? '拒绝'.repeat(160) : null;
    const code = failure === 'missing-code' ? null : CODE;
    expect(await h.service.callback({ state: s.state, code, error })).toEqual({
      sessionId: s.sessionId,
      status: 'failed',
    });
    const row = await session(h, s.sessionId);
    expect(row).toMatchObject({
      status: 'failed',
      used_at: h.clock.now(),
      finished_at: h.clock.now(),
    });
    expect(row.error).toEqual(expect.any(String));
    expect(row.error!.length).toBeGreaterThan(0);
    expect(row.error!.length).toBeLessThanOrEqual(200);
    if (error !== null) expect(row.error).toBe(error.slice(0, 200));
    if (exchangeFailed) expect(row.error).not.toBe(rawExchangeError);
    expect(h.exchange).toHaveBeenCalledTimes(exchangeFailed ? 1 : 0);
    expect(await account(h, a.id)).toEqual(a);
    expect(await credentials(h)).toEqual(beforeCredentials);
    expect(
      (await audits(h)).filter((entry) => entry.action === 'union.reauth_succeeded'),
    ).toHaveLength(0);
    expect(
      await h.service.result({ appId: h.appId, unionAccountId: a.id, sessionId: s.sessionId }),
    ).toEqual({ status: 'failed', error: row.error, finishedAt: h.clock.now() });
    expectNoSecrets(await snapshot(h), [
      ACCESS,
      REFRESH,
      CODE,
      s.state,
      s.authUrl,
      rawExchangeError,
    ]);
    const beforeReplay = await snapshot(h);
    expect(await h.service.callback({ state: s.state, code: CODE, error: null })).toMatchObject({
      status: 'invalid',
    });
    expect(await snapshot(h)).toEqual(beforeReplay);
    expect(h.exchange).toHaveBeenCalledTimes(exchangeFailed ? 1 : 0);
  });
}

it('[AC-B1-22c#15] 未知 state 不写库也不换码', async () => {
  const h = await harness(db());
  const a = await seed(h);
  const s = await start(h, a.id);
  const before = await snapshot(h);
  for (const state of ['', 'not-a-session', `${s.state.slice(0, -1)}!`]) {
    expect(await h.service.callback({ state, code: CODE, error: null })).toEqual({
      sessionId: null,
      status: 'invalid',
    });
  }
  expect(await snapshot(h)).toEqual(before);
  expect(h.exchange).not.toHaveBeenCalled();
});

it('[AC-B1-22c#16] 成功审计故障时，凭据轮换、账号更新与 succeeded 不得部分提交', async () => {
  const h = await harness(db());
  const a = await seed(h);
  await seedCredential(h, a.id);
  const s = await start(h, a.id);
  const beforeCredentials = await credentials(h);
  const beforeAudits = await audits(h);
  h.append.mockClear();
  h.append.mockRejectedValue(new Error('synthetic audit unavailable'));
  // Error transport is not prescribed; either reject or a failed result, but never success.
  const result: unknown = await h.service
    .callback({ state: s.state, code: CODE, error: null })
    .catch((error: unknown) => error);
  expect(result).not.toMatchObject({ status: 'succeeded' });
  expect(h.exchange).toHaveBeenCalledOnce();
  expect(h.append.mock.calls.some(([, input]) => input.action === 'union.reauth_succeeded')).toBe(
    true,
  );
  expect(await account(h, a.id)).toEqual(a);
  expect(await credentials(h)).toEqual(beforeCredentials);
  expect(await audits(h)).toEqual(beforeAudits);
  expect((await session(h, s.sessionId)).status).not.toBe('succeeded');
});
