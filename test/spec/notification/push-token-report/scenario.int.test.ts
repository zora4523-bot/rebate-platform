// B1-12c · BR-ID-07 细则 examples「较新设备行占用后收回」「来回抢占即冻结」(default window 24 h),
// end to end through real logins (identity createSession + B1-12b binding) and the reporter.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DB_TIMEOUT,
  closeSuite,
  expectConflictEvent,
  expectRefusalLog,
  fixture,
  mark,
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
  '[AC-B1-12c#22][BR-ID-07] 例：D5误占→D1旧会话收不回→D1新会话收回→D5再迁即冻结→冻结期不变→到期甲认领',
  async () => {
    const f = await fixture(suite);
    const T = 'pt-device-a-301';
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const s1 = await f.login(d1); // 甲, 04:00
    await f.report(s1, T);
    const d5 = await f.device('2026-10-01T00:00:00.000Z');
    f.at('2026-10-05T05:00:00.000Z');
    const yi = await f.login(d5);
    f.at('2026-10-05T05:10:00.000Z');
    await f.report(yi, T); // D5 registered later: migration
    expect(await ownRow(f, d1)).toMatchObject({ revoked_at: new Date('2026-10-05T05:10:00.000Z') });
    expect(await ownRow(f, d5)).toMatchObject({ user_id: yi.user_id, bound_sid: yi.sid });

    f.at('2026-10-05T05:20:00.000Z');
    const beforeOld = await f.all();
    const beforeRefusal = mark(f);
    await f.report(s1, T); // S1 was created before D5 took T: no reclaim
    expect(await f.all()).toEqual(beforeOld);
    expectRefusalLog(f, [d1, d5], T, beforeRefusal);

    f.at('2026-10-05T05:30:00.000Z');
    const s3 = await f.login(d1, s1.user_id);
    f.at('2026-10-05T05:40:00.000Z');
    await f.report(s3, T); // reclaim
    expect(await ownRow(f, d1)).toMatchObject({
      token: T,
      user_id: s1.user_id,
      bound_sid: s3.sid,
      acquired_by_move_at: new Date('2026-10-05T05:40:00.000Z'),
      revoked_at: null,
    });
    expect(await ownRow(f, d5)).toMatchObject({
      revoked_at: new Date('2026-10-05T05:40:00.000Z'),
      user_id: null,
      bound_sid: null,
    });

    f.at('2026-10-05T06:00:00.000Z');
    const beforeFreeze = mark(f);
    await f.report(yi, T); // D5 again, D1 changed hands 20 minutes ago: freeze
    expect(await ownRow(f, d1)).toMatchObject({
      token: T,
      frozen_until: new Date('2026-10-06T06:00:00.000Z'),
      user_id: null,
      bound_sid: null,
      revoked_at: null,
    });
    expect(await ownRow(f, d5)).toMatchObject({ revoked_at: new Date('2026-10-05T05:40:00.000Z') });
    expectConflictEvent(f, [d1, d5], T, beforeFreeze);

    f.at('2026-10-05T07:00:00.000Z');
    const s4 = await f.login(d1, s1.user_id); // does not bind the frozen row
    const frozen = await f.all();
    await f.report(s4, T);
    await f.report(yi, T);
    expect(await f.all()).toEqual(frozen);

    f.at('2026-10-06T06:00:00.001Z');
    await f.report(s4, T); // expired: the holder's own current session claims it
    expect(await ownRow(f, d1)).toMatchObject({
      token: T,
      user_id: s1.user_id,
      bound_sid: s4.sid,
      revoked_at: null,
    });
    expect(await f.live(T)).toHaveLength(1);
  },
  DB_TIMEOUT,
);
