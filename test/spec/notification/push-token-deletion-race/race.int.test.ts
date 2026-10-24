// F1-02zzl · ruling D10-318 (brief §9.2 ①②, §9.3 ①): a push token report racing the deletion
// cleanup must not leave a token row of the deleted user behind. The cleanup transaction (users
// row FOR UPDATE, then notification's deletePushTokensForUser) runs first and is held uncommitted;
// the report of the user's current session arrives, must be waiting on the cleanup's locks, and
// after the cleanup commits it is ignored as a whole — no push_tokens row is written — while
// report() still resolves (the route answers success; no new error code). Before the fix the report
// waits only on the deleted token row or on the foreign key check and then inserts a fresh row
// carrying the user: the residue this file reproduces. users.status is read under the users lock,
// so a status moved by the racing cleanup itself (normal → deleting / deleted) is the one judged.
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import {
  DB_TIMEOUT,
  RESOLVED,
  cleanTokens,
  closeSuite,
  fixture,
  hold,
  lockUserForUpdate,
  moveStatus,
  openSuite,
  ownRow,
  setStatus,
  settle,
  statusOf,
  tokensOfUser,
  track,
  waitBlocked,
  type Actor,
  type Fixture,
  type GoneStatus,
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

/**
 * `cleanup` runs on a held transaction and stays uncommitted; then `actor` reports `token`, which
 * must be waiting on the cleanup's locks; then the cleanup commits. Returns how the report settled.
 */
async function cleanupFirst(
  f: Fixture,
  actor: Actor,
  token: string,
  cleanup: (trx: Transaction<DB>) => Promise<void>,
): Promise<Settlement> {
  const a = hold(f.db);
  let b: ReturnType<typeof track<Settlement>> | undefined;
  try {
    await a.run(cleanup);
    b = track(settle(f.report(actor, token)));
    // The report really meets the uncommitted cleanup (it neither finished before nor ran past it).
    expect(await waitBlocked(f.db, b.settled)).toBe(true);
    await a.commit();
    return await b.done;
  } finally {
    await a.abandon();
    await b?.done.catch(() => undefined);
  }
}

it(
  '[D10-318][BR-ID-28] 清理先行·用户早已 deleting：清理事务锁 users 行、删掉该用户令牌后未提交，此时同设备当前会话上报同一令牌值；上报须等清理提交，之后整次忽略——该用户在该 app 无令牌行、设备上无行，上报照常 resolve',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const actor = await f.login(d1);
    f.at('2026-10-05T05:00:00.000Z');
    await f.report(actor, 'pd-race-a-001');
    expect(await ownRow(f, d1)).toMatchObject({
      token: 'pd-race-a-001',
      user_id: actor.user_id,
      bound_sid: actor.sid,
      revoked_at: null,
    });
    // The deletion request moved the account to deleting earlier; the cleanup round runs now.
    await setStatus(f, actor.user_id, 'deleting');
    f.at('2026-10-06T05:00:00.000Z');

    const settled = await cleanupFirst(f, actor, 'pd-race-a-001', async (trx) => {
      await lockUserForUpdate(trx, f.appId, actor.user_id);
      expect(await cleanTokens(trx, f.appId, actor.user_id, f.now())).toBe(1);
    });

    expect(settled).toEqual(RESOLVED);
    expect(await tokensOfUser(f, actor.user_id)).toEqual([]);
    expect(await f.rowsOf(d1)).toEqual([]);
    expect(await f.all()).toEqual([]);
    expect(await statusOf(f, actor.user_id)).toBe('deleting');
  },
  DB_TIMEOUT,
);

for (const [status, reason] of [
  ['deleting', null],
  ['deleted', 'merged'],
] as const satisfies readonly (readonly [GoneStatus, string | null])[]) {
  it(
    `[D10-318][BR-ID-28] 清理事务里才把 status 由 normal 改为 ${status}（与删令牌同一事务、未提交）时上报改报新值：上报须在 users 行锁上等到提交，按提交后的 ${status} 整次忽略——该用户无令牌行，上报照常 resolve（先读状态再写的做法在此残留）`,
    async () => {
      const f = await fixture(suite);
      const d1 = await f.device('2026-09-01T00:00:00.000Z');
      const actor = await f.login(d1);
      f.at('2026-10-05T05:00:00.000Z');
      await f.report(actor, 'pd-race-b-001');
      expect(await tokensOfUser(f, actor.user_id)).toHaveLength(1);
      f.at('2026-10-06T05:00:00.000Z');

      const settled = await cleanupFirst(f, actor, 'pd-race-b-002', async (trx) => {
        await lockUserForUpdate(trx, f.appId, actor.user_id);
        await moveStatus(trx, f.appId, actor.user_id, status, reason);
        expect(await cleanTokens(trx, f.appId, actor.user_id, f.now())).toBe(1);
      });

      expect(settled).toEqual(RESOLVED);
      expect(await tokensOfUser(f, actor.user_id)).toEqual([]);
      expect(await f.all()).toEqual([]);
      expect(await statusOf(f, actor.user_id)).toBe(status);
    },
    DB_TIMEOUT,
  );
}

it(
  '[D10-318][BR-ID-28] 新设备首次上报（设备上还没有令牌行）与清理并发：清理在同一事务里置 deleting 并删掉该用户旧设备上的令牌、未提交；新设备当前会话的上报须等清理提交后整次忽略，不新建行，上报照常 resolve',
  async () => {
    const f = await fixture(suite);
    const d0 = await f.device('2026-08-01T00:00:00.000Z');
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const old = await f.login(d0);
    f.at('2026-10-05T05:00:00.000Z');
    await f.report(old, 'pd-race-c-001');
    const actor = await f.login(d1, old.user_id);
    expect(await f.rowsOf(d1)).toEqual([]);
    f.at('2026-10-06T05:00:00.000Z');

    const settled = await cleanupFirst(f, actor, 'pd-race-c-002', async (trx) => {
      await lockUserForUpdate(trx, f.appId, actor.user_id);
      await moveStatus(trx, f.appId, actor.user_id, 'deleting');
      expect(await cleanTokens(trx, f.appId, actor.user_id, f.now())).toBe(1);
    });

    expect(settled).toEqual(RESOLVED);
    expect(await f.rowsOf(d1)).toEqual([]);
    expect(await f.rowsOf(d0)).toEqual([]);
    expect(await tokensOfUser(f, actor.user_id)).toEqual([]);
    expect(await f.all()).toEqual([]);
  },
  DB_TIMEOUT,
);
