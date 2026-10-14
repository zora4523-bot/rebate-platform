import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  openSuite,
  closeSuite,
  openApp,
  device,
  account,
  login,
  seedToken,
  token,
  revocations,
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

for (const reason of ['banned', 'merged', 'admin_revoked'] as const) {
  it(`[BR-ID-07][AC-S1-76#3][AC-S1-76#5] 装配后的按用户${reason}入口解绑全部设备，保留换账号后的新绑定`, async () => {
    const f = await openApp(suite);
    try {
      const user = await account(f);
      const other = await account(f);
      const firstDevice = await device(f);
      const first = await login(f, firstDevice, user.number);
      const firstId = await seedToken(f, firstDevice, first);
      const secondDevice = await device(f);
      const second = await login(f, secondDevice, user.number);
      const secondId = await seedToken(f, secondDevice, second);
      const switchedDevice = await device(f);
      const old = await login(f, switchedDevice, user.number);
      const current = await login(f, switchedDevice, other.number);
      // Seed independently of bind: this case targets the assembled revocation entry only.
      const switchedId = await seedToken(f, switchedDevice, current);
      const untouched = await token(f, switchedId);
      const api = await revocations(f);
      const sids = await f.db.transaction().execute((trx) =>
        api.byUser(trx, {
          app_id: 'couli',
          user_id: user.uid,
          reason,
        }),
      );
      expect(sids.sort()).toEqual([first.sid, second.sid, old.sid].sort());
      for (const id of [firstId, secondId]) {
        expect(await token(f, id)).toMatchObject({
          user_id: null,
          bound_sid: null,
          revoked_at: null,
        });
      }
      for (const sid of sids) {
        expect(
          await f.db
            .selectFrom('sessions')
            .select(['revoked_at', 'revoke_reason'])
            .where('sid', '=', sid)
            .executeTakeFirstOrThrow(),
        ).toEqual({ revoked_at: f.clock.now(), revoke_reason: reason });
      }
      expect(await token(f, switchedId)).toEqual(untouched);
      expect(
        await f.db
          .selectFrom('sessions')
          .select('revoked_at')
          .where('sid', '=', current.sid)
          .executeTakeFirstOrThrow(),
      ).toEqual({ revoked_at: null });
    } finally {
      await f.close();
    }
  });
}

it('[BR-ID-07][AC-S1-76#2] 装配后的按设备入口吊销该设备历史账号sid，另一设备保持绑定', async () => {
  const f = await openApp(suite);
  try {
    const user = await account(f);
    const other = await account(f);
    const d = await device(f);
    const old = await login(f, d, other.number);
    const current = await login(f, d, user.number);
    const id = await seedToken(f, d, current);
    const otherDevice = await device(f);
    const otherSession = await login(f, otherDevice, user.number);
    const otherId = await seedToken(f, otherDevice, otherSession);
    const before = await token(f, otherId);
    const api = await revocations(f);
    const sids = await f.db.transaction().execute((trx) =>
      api.byDevice(trx, {
        app_id: 'couli',
        device_id: d.id,
        reason: 'device_revoked',
      }),
    );
    expect(sids.sort()).toEqual([old.sid, current.sid].sort());
    expect(await token(f, id)).toMatchObject({ user_id: null, bound_sid: null, revoked_at: null });
    expect(await token(f, otherId)).toEqual(before);
    expect(
      await f.db
        .selectFrom('sessions')
        .select('revoked_at')
        .where('sid', '=', otherSession.sid)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revoked_at: null });
    for (const sid of sids) {
      expect(
        await f.db
          .selectFrom('sessions')
          .select(['revoked_at', 'revoke_reason'])
          .where('sid', '=', sid)
          .executeTakeFirstOrThrow(),
      ).toEqual({ revoked_at: f.clock.now(), revoke_reason: 'device_revoked' });
    }
  } finally {
    await f.close();
  }
});

for (const target of ['user', 'device'] as const) {
  it(`[BR-ID-07][AC-S1-76#3] 装配后的按${target}吊销遇到PG写失败，所有会话和令牌一起回滚`, async () => {
    const f = await openApp(suite);
    try {
      const user = await account(f);
      const d = await device(f);
      const s1 = await login(f, d, user.number);
      const s2 = await login(f, d, user.number);
      const id = await seedToken(f, d, s2);
      const api = await revocations(f);
      const invoke = () =>
        f.db
          .transaction()
          .execute((trx) =>
            target === 'user'
              ? api.byUser(trx, { app_id: 'couli', user_id: user.uid, reason: 'admin_revoked' })
              : api.byDevice(trx, { app_id: 'couli', device_id: d.id, reason: 'device_revoked' }),
          );
      const before = await snapshot(f);
      await withTokenWriteFailure(f, id, async () => {
        await expect(invoke()).rejects.toMatchObject({ code: '55P03' });
        expect(await snapshot(f)).toEqual(before);
      });
      expect((await invoke()).sort()).toEqual([s1.sid, s2.sid].sort());
      expect(await token(f, id)).toMatchObject({
        user_id: null,
        bound_sid: null,
        revoked_at: null,
      });
    } finally {
      await f.close();
    }
  });

  it(`[BR-ID-07][AC-S1-76#3] 装配后的按${target}吊销在调用方事务内可见，调用方失败则解绑一并回滚`, async () => {
    const f = await openApp(suite);
    try {
      const user = await account(f);
      const d = await device(f);
      const session = await login(f, d, user.number);
      const id = await seedToken(f, d, session);
      const api = await revocations(f);
      const before = await snapshot(f);
      const abort = new Error('fixture caller abort');
      await expect(
        f.db.transaction().execute(async (trx) => {
          const sids =
            target === 'user'
              ? await api.byUser(trx, {
                  app_id: 'couli',
                  user_id: user.uid,
                  reason: 'admin_revoked',
                })
              : await api.byDevice(trx, {
                  app_id: 'couli',
                  device_id: d.id,
                  reason: 'device_revoked',
                });
          expect(sids).toEqual([session.sid]);
          expect(
            await trx
              .selectFrom('push_tokens')
              .select(['user_id', 'bound_sid'])
              .where('id', '=', id)
              .executeTakeFirstOrThrow(),
          ).toEqual({ user_id: null, bound_sid: null });
          // An observer still sees the committed binding until the caller commits.
          expect(await token(f, id)).toMatchObject({ user_id: user.uid, bound_sid: session.sid });
          throw abort;
        }),
      ).rejects.toBe(abort);
      expect(await snapshot(f)).toEqual(before);
    } finally {
      await f.close();
    }
  });
}
