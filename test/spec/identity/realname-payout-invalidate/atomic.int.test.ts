// B1-27g · the invalidation belongs to the overwrite's transaction, under the same users row lock
// (08 BR-WDR-02 细则「保存在用户级锁内」「实名更正后的失效与重绑」; BR-ID-25 细则「实名更正」; task
// §9.3 ①「仍在同一事务、同一把 users 行锁内；端口抛错 → 整笔回滚」). Two connections, ordered through
// pg_locks rather than timers: another connection holds the user's current payout_accounts row; the
// correction queues for it while invalidating, and at that point the users row must still be locked
// by the correction and the new real name not yet visible. The other connection then moves the
// row's row_version on and commits, so the port's CAS throws: the whole correction is rolled back
// (realname, accounts, change rows, success audit, event). The next correction is accepted and
// writes exactly one exempt row.
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { useHarness, type Response } from '../../admin/auth/kit.ts';
import {
  NEW,
  added,
  audits,
  body,
  correct,
  eventsOf,
  ok,
  realnameOf,
  user,
  verified,
  type User,
} from '../admin-realname/kit.ts';
import { EXEMPT, bound, invalidatedIn, operatorOf, payoutState, setup } from './kit.ts';

const h = useHarness();

/** Whether another connection could take `target`'s users row lock (FOR NO KEY UPDATE) now. */
async function userRowFree(target: User): Promise<boolean> {
  return h.db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('users')
      .select('id')
      .where('app_id', '=', target.appId)
      .where('id', '=', target.id)
      .forNoKeyUpdate()
      .skipLocked()
      .execute();
    return rows.length === 1;
  });
}

/** Polls (about 10 s at most) until some backend of this database waits for a lock held by `pid`. */
async function blockedBy(pid: number, flag: { settled: boolean }): Promise<boolean> {
  for (let i = 0; i < 400 && !flag.settled; i += 1) {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND ${pid}::int = ANY (pg_catalog.pg_blocking_pids(pid))`.execute(h.db);
    if ((rows[0]?.n ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

it('[AC-B1-27g#11] 失效在覆盖事务与用户行锁内：等收款账号行时 users 行仍被锁、新实名未提交；端口 CAS 失败 → 整笔回滚（实名、账号、变更行、成功审计、事件都不留）；随后受理只写一条 exempt 行', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  const account = await bound(h, target, 'alipay', true, 'old.payee@example.com');
  const before = {
    realname: await realnameOf(h, target),
    audits: await audits(h, s.appId),
    events: await eventsOf(h, s.appId),
  };
  expect(before.realname).toBeDefined();
  expect(await userRowFree(target)).toBe(true);

  const flag = { settled: false };
  const run: { pending?: Promise<Response> } = {};
  const seen: { waited?: boolean; userRowFree?: boolean; realname?: unknown } = {};
  // Holds the current account row, lets the correction queue for it, then moves row_version on.
  const moved = await h.db.transaction().execute(async (other) => {
    const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(other);
    await other
      .selectFrom('payout_accounts')
      .select('id')
      .where('app_id', '=', target.appId)
      .where('id', '=', account.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    run.pending = correct(s, target.id, body(NEW)).finally(() => {
      flag.settled = true;
    });
    seen.waited = await blockedBy(rows[0]!.pid, flag);
    seen.userRowFree = await userRowFree(target);
    seen.realname = await realnameOf(h, target);
    return other
      .updateTable('payout_accounts')
      .set({ row_version: account.row_version + 1 })
      .where('app_id', '=', target.appId)
      .where('id', '=', account.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
  expect(run.pending).toBeDefined();
  const response = await run.pending!;

  expect(seen.waited, '更正必须在失效这一步等另一连接持有的收款账号行').toBe(true);
  expect(seen.userRowFree, '等收款账号行时 users 行锁仍由更正事务持有').toBe(false);
  expect(seen.realname, '失效之前实名覆盖尚未提交').toEqual(before.realname);
  expect(response.statusCode, '端口 CAS 失败不得返回成功').not.toBe(200);
  expect(await realnameOf(h, target)).toEqual(before.realname);
  expect(await payoutState(h, target)).toEqual({ accounts: [moved], changes: [] });
  const written = added(before.audits, await audits(h, s.appId));
  expect(written.flatMap(invalidatedIn), '回滚不留成功审计').toEqual([]);
  expect(await eventsOf(h, s.appId)).toEqual(before.events);
  expect(await userRowFree(target)).toBe(true);

  await ok(await correct(s, target.id, body(NEW)));
  const after = await payoutState(h, target);
  expect(after.accounts.filter((row) => row.is_current)).toEqual([]);
  expect(after.changes).toHaveLength(1);
  expect(after.changes[0]).toMatchObject({
    old_payout_method: 'alipay',
    new_payout_method: 'alipay',
    old_hmac: account.alipay_hmac,
    new_hmac: '',
    operator: operatorOf(s.actor.id),
    changed_at: s.clock.now(),
    limit_exempt_reason: EXEMPT,
  });
});
