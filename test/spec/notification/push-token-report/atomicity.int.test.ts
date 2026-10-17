// B1-12c · BR-ID-07 细则「令牌值去重」: 本次上报取得这个令牌值，就在同一事务里把对方那一行作废
// （置 revoked_at，user_id 与 bound_sid 置空）再写自己这一行. r1 review S1: a write failure
// between the two steps (barrier.ts faultOnWrite: the push_tokens write after the first one fails
// before reaching PostgreSQL) must leave both rows exactly as they were before the request.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { faultOnWrite } from './barrier.ts';
import { DB_TIMEOUT, PROVIDER, closeSuite, fixture, openSuite, ownRow, type Suite } from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
}, 30_000);

it(
  '[AC-B1-12c#37][BR-ID-07] 迁移时取得行写入失败：请求失败，持有行仍有效且绑定不变，上报方没有行；故障解除后同一上报照常迁移',
  async () => {
    const f = await fixture(suite);
    const T = 'pt-device-a-501';
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const jia = await f.login(d1);
    const holder = await f.seedToken({
      device_id: d1,
      token: T,
      user_id: jia.user_id,
      bound_sid: jia.sid,
      token_set_at: new Date('2026-09-10T00:00:00.000Z'),
    });
    const d5 = await f.device('2026-10-04T00:00:00.000Z');
    const yi = await f.login(d5);
    f.at('2026-10-05T05:00:00.000Z');
    const before = await f.all();
    const fault = faultOnWrite(f.db);
    const outcome = await f.report(yi, T, PROVIDER, fault.handle).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    expect(fault.writes()).toBeGreaterThanOrEqual(2);
    expect(outcome).toBeInstanceOf(Error);
    expect(await f.all()).toEqual(before);
    expect(await f.rowsOf(d5)).toEqual([]);

    await f.report(yi, T);
    expect(await f.row(holder)).toMatchObject({
      revoked_at: new Date('2026-10-05T05:00:00.000Z'),
      user_id: null,
      bound_sid: null,
    });
    expect(await ownRow(f, d5)).toMatchObject({
      token: T,
      user_id: yi.user_id,
      bound_sid: yi.sid,
      acquired_by_move_at: new Date('2026-10-05T05:00:00.000Z'),
      revoked_at: null,
    });
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#38][BR-ID-07] 收回时取得行写入失败：请求失败，对方持有行与自己先前作废的行都与请求前完全相同',
  async () => {
    const f = await fixture(suite);
    const T = 'pt-device-a-502';
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const mine = await f.seedToken({
      device_id: d1,
      token: T,
      revoked_at: new Date('2026-10-05T04:30:00.000Z'),
    });
    const d5 = await f.device('2026-10-01T00:00:00.000Z');
    const yi = await f.login(d5);
    await f.seedToken({
      device_id: d5,
      token: T,
      user_id: yi.user_id,
      bound_sid: yi.sid,
      token_set_at: new Date('2026-10-05T04:30:00.000Z'),
      acquired_by_move_at: new Date('2026-10-05T04:30:00.000Z'),
    });
    f.at('2026-10-05T05:00:00.000Z');
    const jia = await f.login(d1); // created 05:00, after D5's token_set_at: a reclaim
    f.at('2026-10-05T05:10:00.000Z');
    const before = await f.all();
    const fault = faultOnWrite(f.db);
    const outcome = await f.report(jia, T, PROVIDER, fault.handle).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    expect(fault.writes()).toBeGreaterThanOrEqual(2);
    expect(outcome).toBeInstanceOf(Error);
    expect(await f.all()).toEqual(before);
    expect((await f.live(T)).map((row) => row.device_id)).toEqual([d5]);
    expect((await f.row(mine)).revoked_at).toEqual(new Date('2026-10-05T04:30:00.000Z'));
  },
  DB_TIMEOUT,
);
