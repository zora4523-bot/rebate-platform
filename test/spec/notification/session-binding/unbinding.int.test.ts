import { afterAll, beforeAll, expect, it } from 'vitest';
import { unbindPushTokensForSession } from '../../../../apps/api/src/modules/notification/index.ts';
import { openSuite, closeSuite, fixture, seedUser, type Suite } from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
}, 30_000);

it('[BR-ID-07][AC-S1-76#2] 匹配用户与sid时清空两列，保留令牌行和值；重复命令无副作用', async () => {
  const f = await fixture(suite);
  const id = await f.seedToken();
  const before = await f.token(id);
  await f.unbind();
  expect(await f.token(id)).toMatchObject({
    id,
    user_id: null,
    bound_sid: null,
    revoked_at: null,
    token: before.token,
    token_set_at: before.token_set_at,
    device_id: before.device_id,
    provider: before.provider,
    frozen_until: null,
    acquired_by_move_at: null,
  });
  const unbound = await f.token(id);
  f.clock.advanceMs(1000);
  await f.unbind();
  expect(await f.token(id)).toEqual(unbound);
});

for (const mismatch of ['user', 'sid', 'app'] as const) {
  it(`[BR-ID-07][AC-S1-76#6] 条件解绑的${mismatch}不匹配时整行不变`, async () => {
    const f = await fixture(suite);
    const id = await f.seedToken();
    const before = await f.token(id);
    const otherUser = await seedUser(f.db, f.appId);
    await f.unbind(
      mismatch === 'user' ? otherUser : f.uid,
      mismatch === 'sid' ? 'different-sid' : f.initial.sid,
      mismatch === 'app' ? `${f.appId}_other` : f.appId,
    );
    expect(await f.token(id)).toEqual(before);
  });
}

for (const account of ['same', 'other'] as const) {
  it(`[BR-ID-07][AC-S1-76#6] ${account}账号新登录后旧会话迟到解绑不影响新绑定`, async () => {
    const f = await fixture(suite);
    const id = await f.seedToken();
    const uid = account === 'same' ? f.uid : await seedUser(f.db, f.appId);
    const issued = await f.login(uid);
    const before = await f.token(id);
    await f.unbind();
    expect(await f.token(id)).toEqual(before);
    expect(await f.token(id)).toMatchObject({ user_id: uid, bound_sid: issued.sid });
    expect((await f.deviceRow()).last_login_sid).toBe(issued.sid);
  });
}

it('[BR-ID-07][AC-S1-76#2] 同用户另一台设备的绑定不被当前会话解绑清除', async () => {
  const f = await fixture(suite);
  const id = await f.seedToken();
  const device = await f.device();
  const session = await f.issue(f.uid, device);
  const otherId = await f.seedToken({ device_id: device, bound_sid: session.sid });
  const otherBefore = await f.token(otherId);
  await f.unbind();
  expect(await f.token(id)).toMatchObject({ user_id: null, bound_sid: null, revoked_at: null });
  expect(await f.token(otherId)).toEqual(otherBefore);
});

it('[BR-ID-07][AC-S1-76#2] 条件解绑服从调用方事务，失败回滚保留原绑定', async () => {
  const f = await fixture(suite);
  const id = await f.seedToken();
  const before = await f.token(id);
  const abort = new Error('fixture abort after unbinding');
  await expect(
    f.db.transaction().execute(async (trx) => {
      await unbindPushTokensForSession(
        trx,
        { app_id: f.appId, user_id: f.uid, sid: f.initial.sid },
        f.clock,
      );
      expect(
        await trx
          .selectFrom('push_tokens')
          .select(['user_id', 'bound_sid'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ user_id: null, bound_sid: null });
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await f.token(id)).toEqual(before);
});
