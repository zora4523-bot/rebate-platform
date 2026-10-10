import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  revokeSessionsByDevice,
  revokeSessionsByUser,
} from '../../../../apps/api/src/modules/identity/application/revoke-sessions.ts';
import { success } from '../../identity/session/kit.ts';
import { openSuite, closeSuite, fixture, rejectTokenWrites, seedUser, type Suite } from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
}, 30_000);

it('[BR-ID-07][AC-S1-76#2] 正常刷新不换sid、不重绑；复用吊销后解绑，再登录恢复', async () => {
  const f = await fixture(suite);
  const id = await f.seedToken();
  const before = await f.token(id);
  const device = await f.deviceRow();
  const pair = success(await f.refresh({}, { afterRevoked: f.afterRevoked }));
  expect((await f.tokens.verifyAccess(pair.access_token)).sid).toBe(f.initial.sid);
  expect(await f.token(id)).toEqual(before);
  expect(await f.deviceRow()).toEqual(device);
  f.clock.advanceMs(31_000);
  expect(await f.refresh({}, { afterRevoked: f.afterRevoked })).toEqual({ code: 10404 });
  expect(await f.token(id)).toMatchObject({ user_id: null, bound_sid: null, revoked_at: null });
  expect((await f.session()).revoked_at).toEqual(f.clock.now());
  const issued = await f.login();
  expect(await f.token(id)).toMatchObject({
    user_id: f.uid,
    bound_sid: issued.sid,
    token: before.token,
  });
});

for (const account of ['same', 'other'] as const) {
  it(`[BR-ID-07][AC-S1-76#6] ${account}账号新登录后才检测到旧refresh复用，新会话绑定保留`, async () => {
    const f = await fixture(suite);
    const id = await f.seedToken();
    success(await f.refresh());
    f.clock.advanceMs(31_000);
    const user = account === 'same' ? f.uid : await seedUser(f.db, f.appId);
    const issued = await f.login(user);
    const before = await f.token(id);
    expect(await f.refresh({}, { afterRevoked: f.afterRevoked })).toEqual({ code: 10404 });
    expect((await f.session()).revoked_at).toEqual(f.clock.now());
    expect((await f.session(issued.sid)).revoked_at).toBeNull();
    expect(await f.token(id)).toEqual(before);
    expect(await f.token(id)).toMatchObject({ user_id: user, bound_sid: issued.sid });
  });
}

it('[BR-ID-07][AC-S1-76#2] 复用检测解绑写失败时吊销回滚，修复后可再次吊销并解绑', async () => {
  const f = await fixture(suite);
  const id = await f.seedToken();
  success(await f.refresh());
  f.clock.advanceMs(31_000);
  const before = await f.token(id);
  const session = await f.session();
  const failed = rejectTokenWrites(f.db);
  expect(await f.refresh({}, { db: failed.db, afterRevoked: f.afterRevoked })).toEqual({
    code: 50001,
  });
  expect(failed.attempts()).toBe(1);
  expect(await f.session()).toEqual(session);
  expect(await f.token(id)).toEqual(before);
  // This recovery assertion also prevents a NotImplemented error swallowed by refresh from
  // falsely satisfying the failure case in the red phase.
  expect(await f.refresh({}, { afterRevoked: f.afterRevoked })).toEqual({ code: 10404 });
  expect(await f.token(id)).toMatchObject({ user_id: null, bound_sid: null });
});

for (const reason of ['banned', 'merged', 'admin_revoked'] as const) {
  it(`[BR-ID-07][AC-S1-76#3][AC-S1-76#5] 按用户${reason}吊销全部sid，解绑全部设备，保留其他用户`, async () => {
    const f = await fixture(suite);
    const first = await f.seedToken();
    const device = await f.device();
    const second = await f.issue(f.uid, device);
    const secondId = await f.seedToken({ device_id: device, bound_sid: second.sid });
    const anotherUser = await seedUser(f.db, f.appId);
    const anotherDevice = await f.device();
    const another = await f.issue(anotherUser, anotherDevice);
    const anotherId = await f.seedToken({
      user_id: anotherUser,
      device_id: anotherDevice,
      bound_sid: another.sid,
    });
    const untouched = await f.token(anotherId);
    const sids = await f.db.transaction().execute((trx) =>
      revokeSessionsByUser(
        trx,
        {
          app_id: f.appId,
          user_id: f.uid,
          reason,
        },
        f.clock,
        f.afterRevoked,
      ),
    );
    expect(sids.sort()).toEqual([f.initial.sid, second.sid].sort());
    for (const id of [first, secondId])
      expect(await f.token(id)).toMatchObject({ user_id: null, bound_sid: null, revoked_at: null });
    for (const sid of sids)
      expect(await f.session(sid)).toMatchObject({
        revoked_at: f.clock.now(),
        revoke_reason: reason,
      });
    expect(await f.token(anotherId)).toEqual(untouched);
    expect((await f.session(another.sid)).revoked_at).toBeNull();
  });
}

it('[BR-ID-07][AC-S1-76#2] 按设备吊销该设备全部历史账号sid，另一台设备仍绑定', async () => {
  const f = await fixture(suite);
  const newUser = await seedUser(f.db, f.appId);
  const current = await f.issue(newUser);
  const id = await f.seedToken({ user_id: newUser, bound_sid: current.sid });
  const otherDevice = await f.device();
  const other = await f.issue(f.uid, otherDevice);
  const otherId = await f.seedToken({ device_id: otherDevice, bound_sid: other.sid });
  const untouched = await f.token(otherId);
  const sids = await f.db.transaction().execute((trx) =>
    revokeSessionsByDevice(
      trx,
      {
        app_id: f.appId,
        device_id: f.deviceId,
        reason: 'device_revoked',
      },
      f.clock,
      f.afterRevoked,
    ),
  );
  expect(sids.sort()).toEqual([f.initial.sid, current.sid].sort());
  expect(await f.token(id)).toMatchObject({ user_id: null, bound_sid: null, revoked_at: null });
  expect(await f.token(otherId)).toEqual(untouched);
  expect((await f.session(other.sid)).revoked_at).toBeNull();
});

for (const target of ['user', 'device'] as const) {
  it(`[BR-ID-07][AC-S1-76#3] 按${target}吊销时解绑失败，全部会话与令牌修改回滚`, async () => {
    const f = await fixture(suite);
    const id = await f.seedToken();
    const secondId = await f.seedToken({ provider: 'fcm' });
    const anotherSession = await f.issue();
    const before = [await f.token(id), await f.token(secondId)];
    const sessions = [await f.session(), await f.session(anotherSession.sid)];
    const failed = rejectTokenWrites(f.db);
    const revoke = (db = f.db) =>
      db
        .transaction()
        .execute((trx) =>
          target === 'user'
            ? revokeSessionsByUser(
                trx,
                { app_id: f.appId, user_id: f.uid, reason: 'admin_revoked' },
                f.clock,
                f.afterRevoked,
              )
            : revokeSessionsByDevice(
                trx,
                { app_id: f.appId, device_id: f.deviceId, reason: 'device_revoked' },
                f.clock,
                f.afterRevoked,
              ),
        );
    await expect(revoke(failed.db)).rejects.toBe(failed.failure);
    expect(failed.attempts()).toBe(1);
    expect([await f.token(id), await f.token(secondId)]).toEqual(before);
    expect([await f.session(), await f.session(anotherSession.sid)]).toEqual(sessions);
    await revoke();
    for (const tokenId of [id, secondId])
      expect(await f.token(tokenId)).toMatchObject({ user_id: null, bound_sid: null });
  });
}
