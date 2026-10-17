// B1-12c · BR-ID-07 细则「令牌值去重」「归属」: devices.created_at decides; migration for the later
// device row, reclaim for the earlier one only with a session created after the holder's
// token_set_at (strictly later, no window check); otherwise no write and one log line.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DB_TIMEOUT,
  closeSuite,
  expectRefusalLog,
  fixture,
  openSuite,
  ownRow,
  type Suite,
} from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
}, 30_000);

it(
  '[AC-B1-12c#9][BR-ID-07] 较晚注册的设备行上报对方持有的值：迁移，对方作废并解绑，自己记token_set_at与acquired_by_move_at',
  async () => {
    const f = await fixture(suite);
    const old = await f.device('2026-09-01T00:00:00.000Z');
    const jia = await f.login(old);
    const holder = await f.seedToken({
      device_id: old,
      token: 'pt-device-a-101',
      user_id: jia.user_id,
      bound_sid: jia.sid,
      token_set_at: new Date('2026-09-10T00:00:00.000Z'),
    });
    // Reinstall: a new device row, 乙 logs in and reports the same system token.
    const fresh = await f.device('2026-10-04T00:00:00.000Z');
    const yi = await f.login(fresh);
    f.at('2026-10-05T05:00:00.000Z');
    await f.report(yi, 'pt-device-a-101');
    expect(await f.row(holder)).toMatchObject({
      token: 'pt-device-a-101',
      revoked_at: new Date('2026-10-05T05:00:00.000Z'),
      user_id: null,
      bound_sid: null,
    });
    expect(await ownRow(f, fresh)).toMatchObject({
      token: 'pt-device-a-101',
      user_id: yi.user_id,
      bound_sid: yi.sid,
      token_set_at: new Date('2026-10-05T05:00:00.000Z'),
      acquired_by_move_at: new Date('2026-10-05T05:00:00.000Z'),
      frozen_until: null,
      revoked_at: null,
    });
    expect(await f.live('pt-device-a-101')).toHaveLength(1);
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#10][BR-ID-07] 迁移时上报方已有另一个值的行：在原行上改写，不另建行',
  async () => {
    const f = await fixture(suite);
    const old = await f.device('2026-09-01T00:00:00.000Z');
    const holder = await f.seedToken({ device_id: old, token: 'pt-device-a-102' });
    const fresh = await f.device('2026-10-04T00:00:00.000Z');
    const mine = await f.seedToken({ device_id: fresh, token: 'pt-device-b-102' });
    const yi = await f.login(fresh);
    f.at('2026-10-05T05:30:00.000Z');
    await f.report(yi, 'pt-device-a-102');
    expect(await ownRow(f, fresh)).toMatchObject({
      id: mine,
      token: 'pt-device-a-102',
      user_id: yi.user_id,
      bound_sid: yi.sid,
      token_set_at: new Date('2026-10-05T05:30:00.000Z'),
      acquired_by_move_at: new Date('2026-10-05T05:30:00.000Z'),
      revoked_at: null,
    });
    expect(await f.row(holder)).toMatchObject({
      revoked_at: new Date('2026-10-05T05:30:00.000Z'),
      user_id: null,
      bound_sid: null,
    });
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#11][BR-ID-07] 较早注册的设备行用对方取得之前建的会话上报：不收回，两行都不写，只记日志',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const jia = await f.login(d1); // session created 2026-10-05T04:00:00.000Z
    const mine = await f.seedToken({
      device_id: d1,
      token: 'pt-device-a-103',
      revoked_at: new Date('2026-10-05T04:30:00.000Z'),
    });
    const d5 = await f.device('2026-10-01T00:00:00.000Z');
    const holder = await f.seedToken({
      device_id: d5,
      token: 'pt-device-a-103',
      token_set_at: new Date('2026-10-05T04:30:00.000Z'),
      acquired_by_move_at: new Date('2026-10-05T04:30:00.000Z'),
    });
    const mineBefore = await f.row(mine);
    const holderBefore = await f.row(holder);
    f.at('2026-10-05T06:00:00.000Z');
    await f.report(jia, 'pt-device-a-103');
    expect(await f.row(mine)).toEqual(mineBefore);
    expect(await f.row(holder)).toEqual(holderBefore);
    expectRefusalLog(f, [d1, d5], 'pt-device-a-103');
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#12][BR-ID-07] 收回的比较点严格晚于：会话创建时刻等于对方token_set_at不收回，晚1毫秒收回',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const d5 = await f.device('2026-10-01T00:00:00.000Z');
    const holder = await f.seedToken({
      device_id: d5,
      token: 'pt-device-a-104',
      token_set_at: new Date('2026-10-05T04:00:00.000Z'),
    });
    const equal = await f.login(d1); // sessions.created_at = 2026-10-05T04:00:00.000Z
    const holderBefore = await f.row(holder);
    f.at('2026-10-05T04:05:00.000Z');
    await f.report(equal, 'pt-device-a-104');
    expect(await f.row(holder)).toEqual(holderBefore);
    expect(await f.rowsOf(d1)).toEqual([]);
    f.at('2026-10-05T04:00:00.001Z');
    const later = await f.login(d1, equal.user_id);
    f.at('2026-10-05T04:06:00.000Z');
    await f.report(later, 'pt-device-a-104');
    expect(await f.row(holder)).toMatchObject({
      revoked_at: new Date('2026-10-05T04:06:00.000Z'),
      user_id: null,
      bound_sid: null,
    });
    expect(await ownRow(f, d1)).toMatchObject({
      token: 'pt-device-a-104',
      user_id: equal.user_id,
      bound_sid: later.sid,
      token_set_at: new Date('2026-10-05T04:06:00.000Z'),
      acquired_by_move_at: new Date('2026-10-05T04:06:00.000Z'),
      revoked_at: null,
    });
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#13][BR-ID-07] 收回不做冲突窗口检查：对方刚换行取得，较早设备的新会话仍收回，自己作废的行恢复',
  async () => {
    const f = await fixture(suite, 1);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const mine = await f.seedToken({
      device_id: d1,
      token: 'pt-device-a-105',
      revoked_at: new Date('2026-10-05T03:59:00.000Z'),
    });
    const d5 = await f.device('2026-10-01T00:00:00.000Z');
    const holder = await f.seedToken({
      device_id: d5,
      token: 'pt-device-a-105',
      token_set_at: new Date('2026-10-05T03:59:00.000Z'),
      acquired_by_move_at: new Date('2026-10-05T03:59:00.000Z'),
    });
    const s3 = await f.login(d1); // 04:00:00, after the holder's 03:59 token_set_at
    f.at('2026-10-05T04:01:00.000Z');
    await f.report(s3, 'pt-device-a-105');
    expect(await f.row(mine)).toMatchObject({
      token: 'pt-device-a-105',
      user_id: s3.user_id,
      bound_sid: s3.sid,
      token_set_at: new Date('2026-10-05T04:01:00.000Z'),
      acquired_by_move_at: new Date('2026-10-05T04:01:00.000Z'),
      revoked_at: null,
      frozen_until: null,
    });
    expect(await f.row(holder)).toMatchObject({
      revoked_at: new Date('2026-10-05T04:01:00.000Z'),
      user_id: null,
      bound_sid: null,
      frozen_until: null,
    });
    expect(await f.live('pt-device-a-105')).toHaveLength(1);
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#14][BR-ID-07] 持有方重复上报相同值不推进token_set_at，较早设备的新会话照样收回',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const d5 = await f.device('2026-10-01T00:00:00.000Z');
    const yi = await f.login(d5);
    const holder = await f.seedToken({
      device_id: d5,
      token: 'pt-device-a-106',
      user_id: yi.user_id,
      bound_sid: yi.sid,
      token_set_at: new Date('2026-10-05T03:00:00.000Z'),
      acquired_by_move_at: new Date('2026-10-05T03:00:00.000Z'),
    });
    f.at('2026-10-05T04:10:00.000Z');
    const s3 = await f.login(d1);
    // D5 reports T again after 甲 got S3 and before S3's report arrives.
    f.at('2026-10-05T04:20:00.000Z');
    await f.report(yi, 'pt-device-a-106');
    expect(await f.row(holder)).toMatchObject({
      token_set_at: new Date('2026-10-05T03:00:00.000Z'),
      revoked_at: null,
    });
    f.at('2026-10-05T04:30:00.000Z');
    await f.report(s3, 'pt-device-a-106');
    expect(await f.row(holder)).toMatchObject({
      revoked_at: new Date('2026-10-05T04:30:00.000Z'),
      user_id: null,
      bound_sid: null,
    });
    expect(await ownRow(f, d1)).toMatchObject({
      token: 'pt-device-a-106',
      user_id: s3.user_id,
      bound_sid: s3.sid,
      acquired_by_move_at: new Date('2026-10-05T04:30:00.000Z'),
    });
  },
  DB_TIMEOUT,
);
