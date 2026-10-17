// B1-12c · BR-ID-07 细则「上报时只接受当前会话」「令牌值去重」, 编排者裁定 B1/B2/B6.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { unbindPushTokensForSession } from '../../../../apps/api/src/modules/notification/application/session-bindings.ts';
import { DB_TIMEOUT, PROVIDER, closeSuite, fixture, openSuite, ownRow, type Suite } from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
}, 30_000);

it(
  '[AC-B1-12c#1][BR-ID-07] 当前会话首次上报：新建一行，令牌值与绑定为当前会话，token_set_at取Clock',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const actor = await f.login(d1);
    f.at('2026-10-05T05:00:00.000Z');
    await f.report(actor, 'pt-device-a-001');
    expect(await f.rowsOf(d1)).toEqual([
      expect.objectContaining({
        app_id: f.appId,
        device_id: d1,
        provider: PROVIDER,
        token: 'pt-device-a-001',
        user_id: actor.user_id,
        bound_sid: actor.sid,
        token_set_at: new Date('2026-10-05T05:00:00.000Z'),
        acquired_by_move_at: null,
        frozen_until: null,
        revoked_at: null,
      }),
    ]);
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#2][BR-ID-07] 同一行重复上报相同值：token_set_at不推进，只把绑定写成当前会话',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const id = await f.seedToken({
      device_id: d1,
      token: 'pt-device-a-002',
      token_set_at: new Date('2026-10-01T00:00:00.000Z'),
      acquired_by_move_at: new Date('2026-10-01T00:00:00.000Z'),
    });
    const actor = await f.login(d1);
    // Cleared binding with the session still current (e.g. a freeze that expired): the report binds.
    await f.db
      .updateTable('push_tokens')
      .set({ user_id: null, bound_sid: null })
      .where('id', '=', id)
      .execute();
    f.at('2026-10-05T06:00:00.000Z');
    await f.report(actor, 'pt-device-a-002');
    expect(await f.row(id)).toMatchObject({
      token: 'pt-device-a-002',
      user_id: actor.user_id,
      bound_sid: actor.sid,
      token_set_at: new Date('2026-10-01T00:00:00.000Z'),
      acquired_by_move_at: new Date('2026-10-01T00:00:00.000Z'),
      revoked_at: null,
    });
    expect(await f.rowsOf(d1)).toHaveLength(1);
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#3][BR-ID-07] 改报一个不在别的行上的值：令牌值更新，token_set_at为现在，acquired_by_move_at置空',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const id = await f.seedToken({
      device_id: d1,
      token: 'pt-device-a-003',
      token_set_at: new Date('2026-10-01T00:00:00.000Z'),
      acquired_by_move_at: new Date('2026-10-01T00:00:00.000Z'),
    });
    const actor = await f.login(d1);
    f.at('2026-10-05T07:00:00.000Z');
    await f.report(actor, 'pt-device-a-004');
    expect(await f.row(id)).toMatchObject({
      token: 'pt-device-a-004',
      user_id: actor.user_id,
      bound_sid: actor.sid,
      token_set_at: new Date('2026-10-05T07:00:00.000Z'),
      acquired_by_move_at: null,
      revoked_at: null,
      frozen_until: null,
    });
    expect(await f.rowsOf(d1)).toHaveLength(1);
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#4][BR-ID-07] 自己这一行先前被作废，改报新值：同一行恢复为有效，不另建行',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const id = await f.seedToken({
      device_id: d1,
      token: 'pt-device-a-005',
      revoked_at: new Date('2026-10-02T00:00:00.000Z'),
    });
    const actor = await f.login(d1);
    f.at('2026-10-05T08:00:00.000Z');
    await f.report(actor, 'pt-device-a-006');
    expect(await ownRow(f, d1)).toMatchObject({
      id,
      token: 'pt-device-a-006',
      user_id: actor.user_id,
      bound_sid: actor.sid,
      token_set_at: new Date('2026-10-05T08:00:00.000Z'),
      acquired_by_move_at: null,
      revoked_at: null,
    });
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#5][BR-ID-07] 旧会话的上报晚于新登录：整条忽略，令牌值与绑定都不变（例：甲S1、乙S2）',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const id = await f.seedToken({ device_id: d1, token: 'pt-device-a-007' });
    const jia = await f.login(d1);
    f.at('2026-10-05T04:10:00.000Z');
    const yi = await f.login(d1);
    expect((await f.deviceRow(d1)).last_login_sid).toBe(yi.sid);
    const before = await f.row(id);
    expect(before).toMatchObject({ user_id: yi.user_id, bound_sid: yi.sid });
    f.at('2026-10-05T04:20:00.000Z');
    await f.report(jia, 'pt-device-a-007');
    await f.report(jia, 'pt-device-a-008');
    expect(await f.all()).toEqual([before]);
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#6][BR-ID-07] 退出之后旧会话的上报才到：绑定仍为空、令牌值不变，也不新建行',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const id = await f.seedToken({ device_id: d1, token: 'pt-device-a-009' });
    const jia = await f.login(d1);
    const yi = await f.login(d1);
    // 乙 logs out: B1-12b's conditional unbinding of (乙, S2); last_login_sid stays S2.
    await f.db
      .transaction()
      .execute((trx) =>
        unbindPushTokensForSession(
          trx,
          { app_id: f.appId, user_id: yi.user_id, sid: yi.sid },
          f.clock,
        ),
      );
    expect((await f.deviceRow(d1)).last_login_sid).toBe(yi.sid);
    const before = await f.row(id);
    expect(before).toMatchObject({ user_id: null, bound_sid: null });
    f.at('2026-10-05T09:00:00.000Z');
    await f.report(jia, 'pt-device-a-010');
    expect(await f.all()).toEqual([before]);
    // A device without any token row: a stale session creates nothing.
    const d2 = await f.device('2026-09-02T00:00:00.000Z');
    const old = await f.login(d2);
    await f.login(d2);
    await f.report(old, 'pt-device-b-001');
    expect(await f.rowsOf(d2)).toEqual([]);
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#7][BR-ID-07] 旧会话的旧令牌值迟到：不能把新值改回，也不能把别的行迁过来',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const s1 = await f.login(d1);
    await f.report(s1, 'pt-device-a-011');
    f.at('2026-10-05T05:00:00.000Z');
    const s2 = await f.login(d1, s1.user_id);
    await f.report(s2, 'pt-device-a-012');
    const mine = await ownRow(f, d1);
    expect(mine).toMatchObject({
      token: 'pt-device-a-012',
      user_id: s1.user_id,
      bound_sid: s2.sid,
    });
    // An older device row holds another value: the stale S1 report of that value moves nothing.
    const d0 = await f.device('2026-08-01T00:00:00.000Z');
    const holder = await f.seedToken({ device_id: d0, token: 'pt-device-z-001' });
    const holderBefore = await f.row(holder);
    f.at('2026-10-05T06:00:00.000Z');
    await f.report(s1, 'pt-device-a-011');
    await f.report(s1, 'pt-device-z-001');
    expect(await ownRow(f, d1)).toEqual(mine);
    expect(await f.row(holder)).toEqual(holderBefore);
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#8][BR-ID-07] 所有查询带app_id：别的app同provider同值的有效行不算冲突也不被改动；不同provider不冲突',
  async () => {
    const f = await fixture(suite);
    const otherApp = `${f.appId}_other`;
    const otherDevice = await f.device('2026-10-04T00:00:00.000Z', otherApp);
    const otherUser = await f.user(otherApp);
    const otherId = await f.seedToken({
      app_id: otherApp,
      device_id: otherDevice,
      user_id: otherUser,
      token: 'pt-device-c-001',
      acquired_by_move_at: f.now(),
    });
    const otherBefore = await f.row(otherId);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const d2 = await f.device('2026-09-02T00:00:00.000Z');
    const fcm = await f.seedToken({ device_id: d2, provider: 'fcm', token: 'pt-device-c-001' });
    const fcmBefore = await f.row(fcm);
    const actor = await f.login(d1);
    f.at('2026-10-05T04:30:00.000Z');
    await f.report(actor, 'pt-device-c-001');
    expect(await ownRow(f, d1)).toMatchObject({
      token: 'pt-device-c-001',
      provider: PROVIDER,
      user_id: actor.user_id,
      bound_sid: actor.sid,
      token_set_at: new Date('2026-10-05T04:30:00.000Z'),
      acquired_by_move_at: null,
      revoked_at: null,
    });
    expect(await f.row(otherId)).toEqual(otherBefore);
    expect(await f.row(fcm)).toEqual(fcmBefore);
  },
  DB_TIMEOUT,
);
