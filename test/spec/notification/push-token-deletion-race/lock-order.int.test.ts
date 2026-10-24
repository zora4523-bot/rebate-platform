// F1-02zzl · ruling D10-318 (brief §9.2 ①, §9.3 ④): the report's lock order is users → devices →
// push_tokens, the same order as the deletion cleanup. Pinned two ways:
// - report first: stopped right after its first statement on devices (barrier gateAfter), the
//   report already holds a lock on the user's users row, so the cleanup's FOR UPDATE of that row
//   waits until the report commits; the cleanup then deletes the row the report wrote;
// - cleanup first, locking users and then the device row (users → devices): the report waits on
//   the users row without holding the device row, so the cleanup's device lock does not deadlock.
// A users lock taken after the device row (or none at all) fails both. Both sides complete.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DB_TIMEOUT,
  PROVIDER,
  RESOLVED,
  cleanTokens,
  closeSuite,
  fixture,
  gateAfter,
  hold,
  lockDeviceForUpdate,
  lockUserForUpdate,
  mentionsTable,
  moveStatus,
  openSuite,
  ownRow,
  settle,
  statusOf,
  tokensOfUser,
  track,
  waitBlocked,
  type Settlement,
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
  '[D10-318][BR-ID-28] 锁序 users → devices（上报先行）：上报停在读完 devices 行之后（未提交）时已持有该用户 users 行的锁，清理事务对 users 行的 FOR UPDATE 必须等它；放行后上报先提交、清理随后把它写的令牌删掉，两边都完成、无死锁，最终无残留',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const actor = await f.login(d1);
    f.at('2026-10-05T05:00:00.000Z');
    const gate = gateAfter(f.db, (node) => mentionsTable(node, 'devices'));
    const report = track(settle(f.report(actor, 'pd-order-a-001', PROVIDER, gate.handle)));
    let cleanup: ReturnType<typeof track<number>> | undefined;
    try {
      await Promise.race([gate.entered, report.done]);
      expect(gate.reached()).toBe(true);
      cleanup = track(
        f.db.transaction().execute(async (trx) => {
          await lockUserForUpdate(trx, f.appId, actor.user_id);
          await moveStatus(trx, f.appId, actor.user_id, 'deleting');
          return cleanTokens(trx, f.appId, actor.user_id, f.now());
        }),
      );
      // The users lock is already held when the report is past its device row.
      expect(await waitBlocked(f.db, cleanup.settled)).toBe(true);
      gate.release();
      expect(await report.done).toEqual(RESOLVED);
      // The report committed first under the normal status; the cleanup then deleted its row.
      expect(await cleanup.done).toBe(1);
    } finally {
      gate.release();
      await report.done.catch(() => undefined);
      await cleanup?.done.catch(() => undefined);
    }
    expect(await tokensOfUser(f, actor.user_id)).toEqual([]);
    expect(await f.all()).toEqual([]);
    expect(await statusOf(f, actor.user_id)).toBe('deleting');
  },
  DB_TIMEOUT,
);

it(
  '[D10-318][BR-ID-28] 锁序 users → devices（清理先行且清理也锁设备行）：清理先锁 users 行后停住，上报须在 users 行上等待、不先占设备行；清理再锁该设备行、置 deleting、删令牌并提交，不死锁；上报随后整次忽略并 resolve，无残留',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const actor = await f.login(d1);
    f.at('2026-10-05T05:00:00.000Z');
    await f.report(actor, 'pd-order-b-001');
    expect(await ownRow(f, d1)).toMatchObject({
      token: 'pd-order-b-001',
      user_id: actor.user_id,
      bound_sid: actor.sid,
    });
    f.at('2026-10-06T05:00:00.000Z');

    const a = hold(f.db);
    let b: ReturnType<typeof track<Settlement>> | undefined;
    try {
      await a.run((trx) => lockUserForUpdate(trx, f.appId, actor.user_id));
      b = track(settle(f.report(actor, 'pd-order-b-001')));
      // The report waits on the users row before it touches the device row or the token rows.
      expect(await waitBlocked(f.db, b.settled)).toBe(true);
      const deleted = await a.run(async (trx) => {
        await lockDeviceForUpdate(trx, f.appId, d1);
        await moveStatus(trx, f.appId, actor.user_id, 'deleting');
        return cleanTokens(trx, f.appId, actor.user_id, f.now());
      });
      expect(deleted).toBe(1);
      await a.commit();
      expect(await b.done).toEqual(RESOLVED);
    } finally {
      await a.abandon();
      await b?.done.catch(() => undefined);
    }
    expect(await tokensOfUser(f, actor.user_id)).toEqual([]);
    expect(await f.all()).toEqual([]);
    expect(await statusOf(f, actor.user_id)).toBe('deleting');
  },
  DB_TIMEOUT,
);
