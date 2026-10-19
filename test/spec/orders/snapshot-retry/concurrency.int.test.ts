import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { setupScan, succeed, splits, capture, HOUR } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it.each([
  { mode: 'two-scans', invalidate: false },
  { mode: 'scan-and-pipeline', invalidate: false },
  { mode: 'two-scans', invalidate: true },
  { mode: 'scan-and-pipeline', invalidate: true },
] as const)(
  '[AC-B1-08t#16] $mode 先等待标准订单锁，锁内资格改变=$invalidate 时重读后决定重试',
  async ({ mode, invalidate }) => {
    const applicationName = `snapshot-lock-${mode}-${invalidate}`;
    const contenderDb = createDb({
      connectionString: database!.urlFor('couli_app'),
      max: 2,
      applicationName,
    });
    const gate = Promise.withResolvers<void>();
    const locked = Promise.withResolvers<void>();
    let holding: Promise<void> | undefined;
    const contenders: Promise<unknown>[] = [];
    try {
      const f = await setupScan(contenderDb);
      const port = await succeed(f, contenderDb);
      const before = await f.pending();
      f.clock.advanceMs(HOUR + 1);
      // 独立连接先持有与流水线相同的标准锁；不靠并发启动的偶然时序。
      holding = db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`orders.order_key:jd:${f.incoming.sub_order_id}`}, 0))`.execute(
          trx,
        );
        locked.resolve();
        await gate.promise;
        if (invalidate) {
          await trx
            .updateTable('orders')
            .set({ rebate_status: 'VOID' })
            .where('app_id', '=', f.ctx.app_id)
            .execute();
        }
      });
      await Promise.race([locked.promise, holding]);
      let finished = 0;
      const run = (action: () => Promise<unknown>) =>
        capture(async () => {
          try {
            return await action();
          } finally {
            finished++;
          }
        });
      contenders.push(run(() => f.scan()));
      contenders.push(
        run(() =>
          mode === 'two-scans'
            ? f.scan()
            : f.process({
                ...f.incoming,
                modified_at: f.clock.now(),
                est_commission_fen: 790n,
              }),
        ),
      );
      // Same poll as before (5 s, every 20 ms); the final check is a plain assertion so a
      // skeleton that finishes before the lock is released fails as an assertion.
      const probe = async () => {
        if (finished > 0) return 'completed-before-unlock';
        const waiters = await sql<{ n: bigint }>`
      select count(*)::bigint as n from pg_locks l
      join pg_stat_activity a on a.pid = l.pid
      where a.application_name = ${applicationName}
        and l.locktype = 'advisory' and not l.granted
        `.execute(db);
        return waiters.rows[0]?.n === 2n ? 'blocked' : 'starting';
      };
      let state = await probe();
      for (const deadline = Date.now() + 5_000; state === 'starting' && Date.now() < deadline;) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        state = await probe();
      }
      expect(state).toBe('blocked');
      expect(f.port.create).not.toHaveBeenCalled();
      expect(finished).toBe(0);
      gate.resolve();
      await holding;
      const results = await Promise.all(contenders);
      for (const result of results) expect(result).toMatchObject({ ok: true });
      if (invalidate) {
        expect(port.create).not.toHaveBeenCalled();
        expect(await splits(db, f.ctx.app_id)).toEqual([]);
        expect(await f.pending()).toEqual(before);
      } else {
        expect(port.create).toHaveBeenCalledTimes(1);
        expect(await splits(db, f.ctx.app_id)).toHaveLength(1);
        expect((await f.pending())[0]?.status).toBe('resolved');
      }
    } finally {
      gate.resolve();
      await holding;
      await Promise.allSettled(contenders);
      await destroyDb(contenderDb);
    }
  },
);
