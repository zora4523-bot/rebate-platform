// B1-12c · BR-ID-07 细则: 不取得，就只记一条日志（两个设备行与令牌指纹，供风控排查）; 冻结时写一条
// 风控事件（两个设备行与令牌指纹，不含令牌原文）; 编排者裁定 B5/B6 (flat warn line, code
// PUSH_TOKEN_CONFLICT, never the token value). r1 review S1: per operation exactly one line, and
// the fingerprint is non-empty, the same for the same token and different for different tokens.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DB_TIMEOUT,
  closeSuite,
  expectConflictEvent,
  expectNoTokenText,
  expectRefusalLog,
  fixture,
  mark,
  openSuite,
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
  '[AC-B1-12c#39][BR-ID-07] 拒绝与冻结日志的令牌指纹：每次操作恰一条，同一令牌两次相同、拒绝与冻结相同，两个不同令牌不同，日志不含原文',
  async () => {
    const f = await fixture(suite);
    const A = 'pt-device-a-401';
    const B = 'pt-device-a-402';
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const jia = await f.login(d1); // session created 04:00
    const d5 = await f.device('2026-10-01T00:00:00.000Z');
    const d6 = await f.device('2026-10-02T00:00:00.000Z');
    const d7 = await f.device('2026-10-03T00:00:00.000Z');
    // D5 took A by a move at 04:30 (inside the 24 h window); D6 holds B since 04:30.
    await f.seedToken({
      device_id: d5,
      token: A,
      token_set_at: new Date('2026-10-05T04:30:00.000Z'),
      acquired_by_move_at: new Date('2026-10-05T04:30:00.000Z'),
    });
    await f.seedToken({
      device_id: d6,
      token: B,
      token_set_at: new Date('2026-10-05T04:30:00.000Z'),
    });
    const bing = await f.login(d7);
    f.at('2026-10-05T06:00:00.000Z');

    let since = mark(f);
    await f.report(jia, A); // earlier device, session before D5's token_set_at: refused
    const refusedA = expectRefusalLog(f, [d1, d5], A, since);

    since = mark(f);
    await f.report(jia, A);
    expect(expectRefusalLog(f, [d1, d5], A, since)).toBe(refusedA);

    since = mark(f);
    await f.report(jia, B); // refused against D6
    const refusedB = expectRefusalLog(f, [d1, d6], B, since);
    expect(refusedB).not.toBe(refusedA);
    expect(refusedA.includes(B)).toBe(false);
    expect(refusedB.includes(A)).toBe(false);

    since = mark(f);
    await f.report(bing, A); // later device D7, D5 moved 90 minutes ago: freeze
    expect(expectConflictEvent(f, [d5, d7], A, since)).toBe(refusedA);
    expectNoTokenText(f, A);
    expectNoTokenText(f, B);
  },
  DB_TIMEOUT,
);
