// B1-12c · BR-ID-07 细则「上报时只接受当前会话」(lock the device row first, read last_login_sid
// and write in one transaction) and 「令牌值去重」(partial unique backstop); 编排者裁定 B4.
// Real PostgreSQL concurrency: no mocked locks.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { bindPushTokensForSession } from '../../../../apps/api/src/modules/notification/application/session-bindings.ts';
import { track, waitBlocked } from './barrier.ts';
import { DB_TIMEOUT, closeSuite, fixture, openSuite, ownRow, type Suite } from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
}, 30_000);

it(
  '[AC-B1-12c#23][BR-ID-07] 两台设备并发上报同一新值：两条都成功返回，最终只有一行有效',
  async () => {
    for (let round = 0; round < 5; round += 1) {
      const f = await fixture(suite);
      const token = `pt-race-a-${String(round).padStart(3, '0')}`;
      const d1 = await f.device('2026-09-01T00:00:00.000Z');
      const d5 = await f.device('2026-10-01T00:00:00.000Z');
      const a = await f.login(d1);
      const b = await f.login(d5);
      const results = await Promise.allSettled([f.report(a, token), f.report(b, token)]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await f.live(token)).toHaveLength(1);
    }
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#24][BR-ID-07] 同一设备当前会话并发报两个值：都成功返回，设备只有一行且是其中一个值',
  async () => {
    for (let round = 0; round < 5; round += 1) {
      const f = await fixture(suite);
      const d1 = await f.device('2026-09-01T00:00:00.000Z');
      const actor = await f.login(d1);
      const results = await Promise.allSettled([
        f.report(actor, 'pt-race-b-001'),
        f.report(actor, 'pt-race-b-002'),
      ]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      const row = await ownRow(f, d1);
      expect(['pt-race-b-001', 'pt-race-b-002']).toContain(row.token);
      expect(row).toMatchObject({ user_id: actor.user_id, bound_sid: actor.sid, revoked_at: null });
    }
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12c#25][BR-ID-07] 旧会话上报与同设备新登录并发：上报等到登录提交后按新的last_login_sid判定，整条忽略',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const s1 = await f.login(d1);
    await f.report(s1, 'pt-race-c-001');
    const other = await f.user();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let s2 = '';
    // The new login holds the device row lock (createSession locks it first) until released.
    const loginDone = f.db.transaction().execute(async (trx) => {
      const issued = await createSession(
        trx,
        { uid: other, app_id: f.appId, device_id: d1, scp: 'full' },
        f,
        (same, session) =>
          bindPushTokensForSession(
            same,
            { app_id: f.appId, user_id: other, device_id: d1, sid: session.sid },
            f.clock,
          ),
      );
      s2 = issued.sid;
      entered();
      await gate;
    });
    try {
      await inside;
      const reportDone = track(f.report(s1, 'pt-race-c-002'));
      // Deterministic order: the report must be waiting on the login's locks before it commits.
      expect(await waitBlocked(f.db, reportDone.settled)).toBe(true);
      expect(reportDone.settled()).toBe(false);
      release();
      await loginDone;
      await reportDone.done;
    } finally {
      release();
      await loginDone.catch(() => undefined);
    }
    expect((await f.deviceRow(d1)).last_login_sid).toBe(s2);
    expect(await ownRow(f, d1)).toMatchObject({
      token: 'pt-race-c-001',
      user_id: other,
      bound_sid: s2,
    });
  },
  DB_TIMEOUT,
);
