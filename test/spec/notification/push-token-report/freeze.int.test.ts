// B1-12c · BR-ID-07 细则「冲突冻结」: the window is push.token_conflict_window_hours (positive
// integer hours, default 24, read through the config port); 编排者裁定 B3/B5.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DB_TIMEOUT,
  WINDOW_KEY,
  closeSuite,
  expectConflictEvent,
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

/** Holder D1 (earlier) took T by a move at `acquiredAt`; D5 (later) has a current session. */
async function contested(
  f: Awaited<ReturnType<typeof fixture>>,
  token: string,
  acquiredAt: string,
) {
  const d1 = await f.device('2026-09-01T00:00:00.000Z');
  const jia = await f.login(d1);
  const holder = await f.seedToken({
    device_id: d1,
    token,
    user_id: jia.user_id,
    bound_sid: jia.sid,
    token_set_at: new Date(acquiredAt),
    acquired_by_move_at: new Date(acquiredAt),
  });
  const d5 = await f.device('2026-10-01T00:00:00.000Z');
  const yi = await f.login(d5);
  return { d1, d5, jia, yi, holder };
}

it(
  '[AC-B1-12c#15][BR-ID-07] 默认窗口24小时：持有行窗口内刚换过行又要被较晚设备迁走→冻结持有行并解绑，上报方不写，记风控日志',
  async () => {
    const f = await fixture(suite);
    const c = await contested(f, 'pt-device-a-201', '2026-10-04T05:00:00.000Z');
    f.at('2026-10-05T04:30:00.000Z');
    await f.report(c.yi, 'pt-device-a-201');
    expect(await f.row(c.holder)).toMatchObject({
      token: 'pt-device-a-201',
      frozen_until: new Date('2026-10-06T04:30:00.000Z'),
      user_id: null,
      bound_sid: null,
      revoked_at: null,
      token_set_at: new Date('2026-10-04T05:00:00.000Z'),
      acquired_by_move_at: new Date('2026-10-04T05:00:00.000Z'),
    });
    expect(await f.rowsOf(c.d5)).toEqual([]);
    expectConflictEvent(f, [c.d1, c.d5], 'pt-device-a-201');
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#16][BR-ID-07] 窗口配置为1小时：59分钟前换行的冻结一小时；恰好60分钟前换行的照常迁移',
  async () => {
    const f = await fixture(suite, 1);
    const c = await contested(f, 'pt-device-a-202', '2026-10-05T03:01:00.000Z');
    await f.report(c.yi, 'pt-device-a-202');
    expect(await f.row(c.holder)).toMatchObject({
      frozen_until: new Date('2026-10-05T05:00:00.000Z'),
      user_id: null,
      bound_sid: null,
      revoked_at: null,
    });
    expect(await f.rowsOf(c.d5)).toEqual([]);
    expect(f.configCalls).toContainEqual([f.appId, WINDOW_KEY]);

    const g = await fixture(suite, 1);
    const e = await contested(g, 'pt-device-a-203', '2026-10-05T03:00:00.000Z');
    await g.report(e.yi, 'pt-device-a-203');
    expect(await g.row(e.holder)).toMatchObject({
      revoked_at: new Date('2026-10-05T04:00:00.000Z'),
      frozen_until: null,
      user_id: null,
      bound_sid: null,
    });
    expect(await ownRow(g, e.d5)).toMatchObject({
      token: 'pt-device-a-203',
      user_id: e.yi.user_id,
      bound_sid: e.yi.sid,
      acquired_by_move_at: new Date('2026-10-05T04:00:00.000Z'),
    });
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#17][BR-ID-07] 窗口配置为1小时：2小时前换行的照常迁移（默认24小时下会冻结）',
  async () => {
    const f = await fixture(suite, 1);
    const c = await contested(f, 'pt-device-a-204', '2026-10-05T02:00:00.000Z');
    await f.report(c.yi, 'pt-device-a-204');
    expect(await f.row(c.holder)).toMatchObject({
      revoked_at: new Date('2026-10-05T04:00:00.000Z'),
      frozen_until: null,
    });
    expect(await ownRow(f, c.d5)).toMatchObject({
      token: 'pt-device-a-204',
      acquired_by_move_at: new Date('2026-10-05T04:00:00.000Z'),
    });
  },
  DB_TIMEOUT,
);

for (const configured of [null, 0, -1, 1.5, '1'] as const) {
  it(
    `[AC-B1-12c#18][BR-ID-07] 配置读不到或不是正整数（${JSON.stringify(configured)}）按默认24小时`,
    async () => {
      const f = await fixture(suite, configured);
      const c = await contested(f, 'pt-device-a-205', '2026-10-05T02:00:00.000Z');
      await f.report(c.yi, 'pt-device-a-205');
      expect(await f.row(c.holder)).toMatchObject({
        frozen_until: new Date('2026-10-06T04:00:00.000Z'),
        user_id: null,
        bound_sid: null,
        revoked_at: null,
      });
      expect(await f.rowsOf(c.d5)).toEqual([]);
    },
    DB_TIMEOUT,
  );
}

it(
  '[AC-B1-12c#19][BR-ID-07] 冻结期内：持有行当前会话报同值或新值、较晚设备迁移、较早设备新会话收回，一律不写',
  async () => {
    const f = await fixture(suite, 1);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const holder = await f.seedToken({
      device_id: d1,
      token: 'pt-device-a-206',
      token_set_at: new Date('2026-10-05T03:30:00.000Z'),
      acquired_by_move_at: new Date('2026-10-05T03:30:00.000Z'),
      frozen_until: new Date('2026-10-05T04:30:00.000Z'),
    });
    const d0 = await f.device('2026-08-01T00:00:00.000Z');
    const d5 = await f.device('2026-10-01T00:00:00.000Z');
    const own5 = await f.seedToken({ device_id: d5, token: 'pt-device-b-206' });
    const s4 = await f.login(d1); // login does not bind a frozen row
    const yi = await f.login(d5);
    const early = await f.login(d0); // created 04:00, after the holder's token_set_at
    const before = await f.all();
    expect(await f.row(holder)).toMatchObject({ user_id: null, bound_sid: null });
    f.at('2026-10-05T04:29:59.999Z');
    await f.report(s4, 'pt-device-a-206');
    await f.report(s4, 'pt-device-a-207');
    await f.report(yi, 'pt-device-a-206');
    await f.report(early, 'pt-device-a-206');
    expect(await f.all()).toEqual(before);
    expect(await f.row(own5)).toMatchObject({ token: 'pt-device-b-206' });
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#20][BR-ID-07] 到期（frozen_until等于现在）后持有行当前会话上报：写入绑定，token_set_at不推进',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const holder = await f.seedToken({
      device_id: d1,
      token: 'pt-device-a-208',
      token_set_at: new Date('2026-10-04T03:00:00.000Z'),
      acquired_by_move_at: new Date('2026-10-04T03:00:00.000Z'),
      frozen_until: new Date('2026-10-05T04:30:00.000Z'),
    });
    const s4 = await f.login(d1);
    f.at('2026-10-05T04:30:00.000Z');
    await f.report(s4, 'pt-device-a-208');
    expect(await f.row(holder)).toMatchObject({
      token: 'pt-device-a-208',
      user_id: s4.user_id,
      bound_sid: s4.sid,
      token_set_at: new Date('2026-10-04T03:00:00.000Z'),
      revoked_at: null,
    });
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#21][BR-ID-07] 到期之后较晚设备行上报：按归属迁移，记为一次新的迁移',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const holder = await f.seedToken({
      device_id: d1,
      token: 'pt-device-a-209',
      token_set_at: new Date('2026-10-04T03:00:00.000Z'),
      acquired_by_move_at: new Date('2026-10-04T03:00:00.000Z'),
      frozen_until: new Date('2026-10-05T03:00:00.000Z'),
    });
    const d5 = await f.device('2026-10-01T00:00:00.000Z');
    const yi = await f.login(d5);
    f.at('2026-10-05T04:30:00.000Z');
    await f.report(yi, 'pt-device-a-209');
    expect(await f.row(holder)).toMatchObject({
      revoked_at: new Date('2026-10-05T04:30:00.000Z'),
      user_id: null,
      bound_sid: null,
    });
    expect(await ownRow(f, d5)).toMatchObject({
      token: 'pt-device-a-209',
      user_id: yi.user_id,
      bound_sid: yi.sid,
      token_set_at: new Date('2026-10-05T04:30:00.000Z'),
      acquired_by_move_at: new Date('2026-10-05T04:30:00.000Z'),
      revoked_at: null,
    });
  },
  DB_TIMEOUT,
);
