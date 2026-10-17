// B1-12c · BR-ID-07 细则「上报时只接受当前会话」: 并发冲突以部分唯一约束兜底，冲突的一方在同一事务里
// 重读后按本条再判一次; 读 last_login_sid 与写令牌行在同一事务内，先锁设备行，不得先读后写
// (编排者裁定 B1、B4). r1 review S1: the interleavings are fixed with explicit stop points on the
// reporter's own handle (barrier.ts gateAfter) and lock-wait polling (waitBlocked), not sleeps.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { gateAfter, mentionsTable, track, waitBlocked, writesTable } from './barrier.ts';
import {
  DB_TIMEOUT,
  PROVIDER,
  closeSuite,
  expectRefusalLog,
  fixture,
  mark,
  openSuite,
  ownRow,
  type Actor,
  type Suite,
} from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
}, 30_000);

type Fx = Awaited<ReturnType<typeof fixture>>;

/**
 * `first` reports `token` and stops right after its first push_tokens write (uncommitted); then
 * `second` (resolved by `prepare`, which may log in) reports the same token and must be waiting on
 * `first`'s locks; then `first` commits. Both reports settle before this returns.
 */
async function contend(
  f: Fx,
  token: string,
  first: Actor,
  prepare: () => Promise<Actor>,
): Promise<void> {
  const gate = gateAfter(f.db, (node) => writesTable(node, 'push_tokens'));
  const one = track(f.report(first, token, PROVIDER, gate.handle));
  let two: ReturnType<typeof track<void>> | undefined;
  try {
    await Promise.race([gate.entered, one.done]);
    expect(gate.reached()).toBe(true);
    const second = await prepare();
    two = track(f.report(second, token));
    // The second report really meets the first one's uncommitted row (the unique conflict path).
    expect(await waitBlocked(f.db, two.settled)).toBe(true);
    gate.release();
    await one.done;
    await two.done;
  } finally {
    gate.release();
    await one.done.catch(() => undefined);
    await two?.done.catch(() => undefined);
  }
}

it(
  '[AC-B1-12c#33][BR-ID-07] 并发唯一冲突·较早设备先插入未提交：较晚设备撞约束后重读重判→迁移取得，较早一行作废',
  async () => {
    const f = await fixture(suite);
    const T = 'pt-race-d-001';
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const d5 = await f.device('2026-10-01T00:00:00.000Z');
    const a = await f.login(d1);
    const b = await f.login(d5);
    f.at('2026-10-05T05:00:00.000Z');
    await contend(f, T, a, async () => b);
    expect(await ownRow(f, d1)).toMatchObject({
      token: T,
      user_id: null,
      bound_sid: null,
      token_set_at: new Date('2026-10-05T05:00:00.000Z'),
      acquired_by_move_at: null,
      revoked_at: new Date('2026-10-05T05:00:00.000Z'),
    });
    expect(await ownRow(f, d5)).toMatchObject({
      token: T,
      user_id: b.user_id,
      bound_sid: b.sid,
      token_set_at: new Date('2026-10-05T05:00:00.000Z'),
      acquired_by_move_at: new Date('2026-10-05T05:00:00.000Z'),
      frozen_until: null,
      revoked_at: null,
    });
    expect((await f.live(T)).map((row) => row.device_id)).toEqual([d5]);
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#34][BR-ID-07] 并发唯一冲突·较晚设备先插入未提交：较早设备的旧会话撞约束后重读重判→不收回，不写，只记一条日志',
  async () => {
    const f = await fixture(suite);
    const T = 'pt-race-d-002';
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const d5 = await f.device('2026-10-01T00:00:00.000Z');
    const a = await f.login(d1); // session created 04:00, before D5 takes T at 05:00
    const b = await f.login(d5);
    f.at('2026-10-05T05:00:00.000Z');
    const since = mark(f);
    await contend(f, T, b, async () => a);
    expect(await f.rowsOf(d1)).toEqual([]);
    expect(await ownRow(f, d5)).toMatchObject({
      token: T,
      user_id: b.user_id,
      bound_sid: b.sid,
      token_set_at: new Date('2026-10-05T05:00:00.000Z'),
      acquired_by_move_at: null,
      revoked_at: null,
    });
    expectRefusalLog(f, [d1, d5], T, since);
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#35][BR-ID-07] 并发唯一冲突·较晚设备先插入未提交：较早设备晚于其token_set_at的新会话撞约束后重读重判→收回',
  async () => {
    const f = await fixture(suite);
    const T = 'pt-race-d-003';
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const d5 = await f.device('2026-10-01T00:00:00.000Z');
    const b = await f.login(d5);
    f.at('2026-10-05T05:00:00.000Z'); // D5's insert carries token_set_at 05:00
    let a: Actor | undefined;
    await contend(f, T, b, async () => {
      f.at('2026-10-05T05:10:00.000Z');
      a = await f.login(d1); // session created 05:10, after D5's token_set_at
      return a;
    });
    expect(await ownRow(f, d5)).toMatchObject({
      token: T,
      user_id: null,
      bound_sid: null,
      revoked_at: new Date('2026-10-05T05:10:00.000Z'),
    });
    expect(await ownRow(f, d1)).toMatchObject({
      token: T,
      user_id: a!.user_id,
      bound_sid: a!.sid,
      token_set_at: new Date('2026-10-05T05:10:00.000Z'),
      acquired_by_move_at: new Date('2026-10-05T05:10:00.000Z'),
      revoked_at: null,
    });
    expect((await f.live(T)).map((row) => row.device_id)).toEqual([d1]);
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#36][BR-ID-07] 上报先行：上报读到last_login_sid=S1后停住，同设备新登录S2必须等它提交；最终令牌值为上报值、绑定为S2',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const s1 = await f.login(d1);
    await f.report(s1, 'pt-race-e-001');
    const other = await f.user();
    // Stop right after the report's first statement on devices (where it reads last_login_sid).
    const gate = gateAfter(f.db, (node) => mentionsTable(node, 'devices'));
    const report = track(f.report(s1, 'pt-race-e-002', PROVIDER, gate.handle));
    let login: ReturnType<typeof track<Actor>> | undefined;
    try {
      await Promise.race([gate.entered, report.done]);
      expect(gate.reached()).toBe(true);
      login = track(f.login(d1, other));
      // A report holding the device row lock makes the login wait; one that read last_login_sid
      // without the lock lets the login commit S2 now and then writes the binding back to S1.
      await waitBlocked(f.db, login.settled);
      gate.release();
      await report.done;
      await login.done;
    } finally {
      gate.release();
      await report.done.catch(() => undefined);
      await login?.done.catch(() => undefined);
    }
    const s2 = await login!.done;
    expect((await f.deviceRow(d1)).last_login_sid).toBe(s2.sid);
    expect(await ownRow(f, d1)).toMatchObject({
      token: 'pt-race-e-002',
      user_id: other,
      bound_sid: s2.sid,
      revoked_at: null,
    });
  },
  DB_TIMEOUT,
);
