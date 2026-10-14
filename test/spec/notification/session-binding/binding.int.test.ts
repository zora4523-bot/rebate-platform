import { afterAll, beforeAll, expect, it } from 'vitest';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { bindPushTokensForSession } from '../../../../apps/api/src/modules/notification/index.ts';
import { openSuite, closeSuite, fixture, rejectTokenWrites, seedUser, type Suite } from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
}, 30_000);

for (const account of ['same', 'other'] as const) {
  it(`[AC-S1-76#6][BR-ID-07] ${account}账号重新登录绑定已有令牌，其他设备保持原样`, async () => {
    const f = await fixture(suite);
    const id = await f.seedToken();
    const before = await f.token(id);
    const otherDevice = await f.device();
    const otherSession = await f.issue(f.uid, otherDevice);
    const otherId = await f.seedToken({ device_id: otherDevice, bound_sid: otherSession.sid });
    const otherBefore = await f.token(otherId);
    const uid = account === 'same' ? f.uid : await seedUser(f.db, f.appId);
    const issued = await f.login(uid);
    expect(issued.sid).not.toBe(f.initial.sid);
    expect(await f.token(id)).toMatchObject({
      user_id: uid,
      bound_sid: issued.sid,
      token: before.token,
      token_set_at: before.token_set_at,
      revoked_at: null,
    });
    expect((await f.deviceRow()).last_login_sid).toBe(issued.sid);
    expect(await f.token(otherId)).toEqual(otherBefore);
  });
}

for (const freeze of ['future', 'equal', 'past'] as const) {
  it(`[AC-S1-76#15][BR-ID-07] 登录绑定使用Clock判断冻结期：${freeze}`, async () => {
    const f = await fixture(suite);
    // Clock is fixed at 2026-10-05T04:00:00Z by the existing token fixture.
    const frozen = new Date(
      {
        future: '2026-10-05T04:00:00.001Z',
        equal: '2026-10-05T04:00:00.000Z',
        past: '2026-10-05T03:59:59.999Z',
      }[freeze],
    );
    const id = await f.seedToken({ user_id: null, bound_sid: null, frozen_until: frozen });
    const before = await f.token(id);
    const issued = await f.login();
    if (freeze === 'future') expect(await f.token(id)).toEqual(before);
    else expect(await f.token(id)).toMatchObject({ user_id: f.uid, bound_sid: issued.sid });
    expect((await f.deviceRow()).last_login_sid).toBe(issued.sid);
  });
}

it('[BR-ID-07][AC-S1-76#6] 没有令牌行时不创建；已作废行不恢复也不绑定', async () => {
  const f = await fixture(suite);
  await f.login();
  expect(
    await f.db.selectFrom('push_tokens').selectAll().where('app_id', '=', f.appId).execute(),
  ).toEqual([]);
  const id = await f.seedToken({ user_id: null, bound_sid: null, revoked_at: f.clock.now() });
  const before = await f.token(id);
  const issued = await f.login();
  expect(await f.token(id)).toEqual(before);
  expect((await f.deviceRow()).last_login_sid).toBe(issued.sid);
});

it('[BR-ID-07][AC-S1-76#6] 同设备不同provider的有效令牌都绑定；其他app不受影响', async () => {
  const f = await fixture(suite);
  const ids = [await f.seedToken(), await f.seedToken({ provider: 'fcm' })];
  const otherApp = `${f.appId}_other`;
  const otherUser = await seedUser(f.db, otherApp);
  const otherDevice = await f.device(otherApp);
  const other = await f.issue(otherUser, otherDevice, otherApp);
  const otherId = await f.seedToken({
    app_id: otherApp,
    user_id: otherUser,
    device_id: otherDevice,
    bound_sid: other.sid,
  });
  const before = await f.token(otherId);
  const issued = await f.login();
  for (const id of ids)
    expect(await f.token(id)).toMatchObject({ user_id: f.uid, bound_sid: issued.sid });
  expect(await f.token(otherId)).toEqual(before);
});

it('[BR-ID-07][AC-S1-76#6] 绑定在创建会话的同一事务可见，调用方失败则四处写入一起回滚', async () => {
  const f = await fixture(suite);
  const id = await f.seedToken();
  const before = await f.token(id);
  const device = await f.deviceRow();
  const sessions = await f.db
    .selectFrom('sessions')
    .selectAll()
    .where('app_id', '=', f.appId)
    .execute();
  const refresh = await f.db
    .selectFrom('refresh_tokens')
    .selectAll()
    .where('app_id', '=', f.appId)
    .execute();
  const abort = new Error('fixture abort after binding');
  await expect(
    f.db.transaction().execute(async (trx) => {
      await createSession(
        trx,
        { uid: f.uid, app_id: f.appId, device_id: f.deviceId, scp: 'full' },
        f,
        async (sameTransaction, issued) => {
          expect(sameTransaction).toBe(trx);
          expect(
            await trx
              .selectFrom('devices')
              .select('last_login_sid')
              .where('id', '=', f.deviceId)
              .executeTakeFirstOrThrow(),
          ).toEqual({ last_login_sid: issued.sid });
          await bindPushTokensForSession(
            sameTransaction,
            {
              app_id: f.appId,
              user_id: f.uid,
              device_id: f.deviceId,
              sid: issued.sid,
            },
            f.clock,
          );
          expect(
            await trx
              .selectFrom('push_tokens')
              .select(['user_id', 'bound_sid'])
              .where('id', '=', id)
              .executeTakeFirstOrThrow(),
          ).toEqual({ user_id: f.uid, bound_sid: issued.sid });
        },
      );
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await f.token(id)).toEqual(before);
  expect(await f.deviceRow()).toEqual(device);
  expect(
    await f.db.selectFrom('sessions').selectAll().where('app_id', '=', f.appId).execute(),
  ).toEqual(sessions);
  expect(
    await f.db.selectFrom('refresh_tokens').selectAll().where('app_id', '=', f.appId).execute(),
  ).toEqual(refresh);
});

it('[BR-ID-07][AC-S1-76#6] 真实PG同设备并发登录完成后，绑定属于最后一次登录', async () => {
  const f = await fixture(suite);
  const id = await f.seedToken();
  const otherUser = await seedUser(f.db, f.appId);
  const issued = await Promise.all([f.login(), f.login(otherUser)]);
  const sid = (await f.deviceRow()).last_login_sid;
  expect(issued.map((session) => session.sid)).toContain(sid);
  const latest = await f.session(sid!);
  expect(await f.token(id)).toMatchObject({ user_id: latest.user_id, bound_sid: sid });
});

it('[BR-ID-07][AC-S1-76#6] 登录绑定写失败时，设备代际、会话和refresh全部回滚', async () => {
  const f = await fixture(suite);
  const id = await f.seedToken();
  const token = await f.token(id);
  const device = await f.deviceRow();
  const sessions = await f.db
    .selectFrom('sessions')
    .selectAll()
    .where('app_id', '=', f.appId)
    .execute();
  const refresh = await f.db
    .selectFrom('refresh_tokens')
    .selectAll()
    .where('app_id', '=', f.appId)
    .execute();
  const failed = rejectTokenWrites(f.db);
  await expect(
    failed.db.transaction().execute((trx) =>
      createSession(
        trx,
        { uid: f.uid, app_id: f.appId, device_id: f.deviceId, scp: 'full' },
        f,
        (sameTransaction, issued) =>
          bindPushTokensForSession(
            sameTransaction,
            {
              app_id: f.appId,
              user_id: f.uid,
              device_id: f.deviceId,
              sid: issued.sid,
            },
            f.clock,
          ),
      ),
    ),
  ).rejects.toBe(failed.failure);
  expect(failed.attempts()).toBe(1);
  expect(await f.token(id)).toEqual(token);
  expect(await f.deviceRow()).toEqual(device);
  expect(
    await f.db.selectFrom('sessions').selectAll().where('app_id', '=', f.appId).execute(),
  ).toEqual(sessions);
  expect(
    await f.db.selectFrom('refresh_tokens').selectAll().where('app_id', '=', f.appId).execute(),
  ).toEqual(refresh);
});
