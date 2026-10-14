import { afterAll, beforeAll, expect, it } from 'vitest';
import { accepted, rejected } from '../../identity/session/http-kit.ts';
import {
  openSuite,
  closeSuite,
  openApp,
  device,
  account,
  login,
  seedToken,
  token,
  assertBound,
  snapshot,
  withTokenWriteFailure,
  type Suite,
} from './assembled-kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
}, 30_000);

it('[BR-ID-07][AC-S1-76#2] HTTP复用检测10404解绑当前设备，其他设备不变，重新登录恢复', async () => {
  const f = await openApp(suite);
  try {
    const user = await account(f);
    const d = await device(f);
    const s1 = await login(f, d, user.number);
    const id = await seedToken(f, d, s1);
    const another = await device(f);
    const s3 = await login(f, another, user.number);
    const otherId = await seedToken(f, another, s3);
    const otherBefore = await token(f, otherId);
    const before = await token(f, id);
    await accepted(await d.post('/v1/auth/refresh', { refresh_token: s1.refresh_token }));
    expect(await token(f, id)).toEqual(before);
    f.clock.advanceMs(31_000);
    await rejected(await d.post('/v1/auth/refresh', { refresh_token: s1.refresh_token }), 10404);
    expect(await token(f, id)).toMatchObject({
      user_id: null,
      bound_sid: null,
      revoked_at: null,
      token: before.token,
    });
    expect(
      await f.db
        .selectFrom('sessions')
        .select(['revoked_at', 'revoke_reason'])
        .where('sid', '=', s1.sid)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revoked_at: f.clock.now(), revoke_reason: 'refresh_reuse' });
    expect(await token(f, otherId)).toEqual(otherBefore);
    expect(
      await f.db
        .selectFrom('sessions')
        .select('revoked_at')
        .where('sid', '=', s3.sid)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revoked_at: null });
    const recovered = await login(f, d, user.number);
    expect(recovered.sid).not.toBe(s1.sid);
    await assertBound(f, d, id, recovered);
  } finally {
    await f.close();
  }
});

for (const who of ['same', 'other'] as const) {
  it(`[BR-ID-07][AC-S1-76#6] ${who}账号真实新登录后，旧会话HTTP复用吊销保留新绑定`, async () => {
    const f = await openApp(suite);
    try {
      const user = await account(f);
      const d = await device(f);
      const old = await login(f, d, user.number);
      const id = await seedToken(f, d, old);
      await accepted(await d.post('/v1/auth/refresh', { refresh_token: old.refresh_token }));
      const currentUser = who === 'same' ? user : await account(f);
      const current = await login(f, d, currentUser.number);
      await assertBound(f, d, id, current);
      const before = await token(f, id);
      await rejected(await d.post('/v1/auth/refresh', { refresh_token: old.refresh_token }), 10404);
      expect(await token(f, id)).toEqual(before);
      expect(
        await f.db
          .selectFrom('sessions')
          .select('revoked_at')
          .where('sid', '=', old.sid)
          .executeTakeFirstOrThrow(),
      ).toEqual({ revoked_at: f.clock.now() });
      expect(
        await f.db
          .selectFrom('sessions')
          .select('revoked_at')
          .where('sid', '=', current.sid)
          .executeTakeFirstOrThrow(),
      ).toEqual({ revoked_at: null });
      // Also prove the real logout assembly, without a fixture-supplied afterRevoked hook.
      const logout = await d.post('/v1/auth/logout', {}, current.access_token);
      expect(logout.statusCode).toBe(200);
      expect(logout.json()).toMatchObject({ code: 0, data: {} });
      expect(await token(f, id)).toMatchObject({
        user_id: null,
        bound_sid: null,
        revoked_at: null,
      });
    } finally {
      await f.close();
    }
  });
}

for (const action of ['logout', 'reuse'] as const) {
  it(`[BR-ID-07][AC-S1-76#2] HTTP ${action}解绑的PG写失败使吊销回滚，解除故障后才吊销`, async () => {
    const f = await openApp(suite);
    try {
      const user = await account(f);
      const d = await device(f);
      const session = await login(f, d, user.number);
      const id = await seedToken(f, d, session);
      if (action === 'reuse') {
        await accepted(await d.post('/v1/auth/refresh', { refresh_token: session.refresh_token }));
        f.clock.advanceMs(31_000);
      }
      const invoke = () =>
        action === 'logout'
          ? d.post('/v1/auth/logout', {}, session.access_token)
          : d.post('/v1/auth/refresh', { refresh_token: session.refresh_token });
      const before = await snapshot(f);
      await withTokenWriteFailure(f, id, async () => {
        const failure = await invoke();
        expect(failure.statusCode).toBe(500);
        expect(failure.json()).toMatchObject({ code: 50001 });
        expect(await snapshot(f)).toEqual(before);
      });
      const recovered = await invoke();
      if (action === 'reuse') await rejected(recovered, 10404);
      else {
        expect(recovered.statusCode).toBe(200);
        expect(recovered.json()).toMatchObject({ code: 0 });
      }
      expect(await token(f, id)).toMatchObject({
        user_id: null,
        bound_sid: null,
        revoked_at: null,
      });
      expect(
        await f.db
          .selectFrom('sessions')
          .select('revoked_at')
          .where('sid', '=', session.sid)
          .executeTakeFirstOrThrow(),
      ).toEqual({ revoked_at: f.clock.now() });
    } finally {
      await f.close();
    }
  });
}
