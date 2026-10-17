import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { lockOrderKey } from '../../../../apps/api/src/modules/orders/infra/order-lock.ts';
import { capture, fixture, pipeline, snapshot, traceQueries } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-08h#51] 同一新单并发两路只插一行，锁后重读使另一条 unchanged', async () => {
  const f = await fixture(db);
  const p = await pipeline(f.deps);
  const q = await pipeline(f.deps);
  const results = await Promise.all([p.process(f.incoming, f.ctx), q.process(f.incoming, f.ctx)]);
  expect(results.map((r) => r.kind).sort()).toEqual(['inserted', 'unchanged']);
  const s = await snapshot(db, f.ctx.app_id);
  expect(s.keys).toHaveLength(1);
  expect(s.orders).toHaveLength(1);
  expect(s.history).toHaveLength(1);
  expect(f.onImported).toHaveBeenCalledTimes(1);
});

it('[AC-B1-08h#52] 同单丢弃去重与异单计数并发均无丢失更新', async () => {
  const f = await fixture(db);
  f.findPid.mockResolvedValue([]);
  const p = await pipeline(f.deps);
  const results = await Promise.all([
    p.process(f.incoming, f.ctx),
    p.process(f.incoming, f.ctx),
    p.process({ ...f.incoming, sub_order_id: `${f.incoming.sub_order_id}-2` }, f.ctx),
    p.process({ ...f.incoming, sub_order_id: `${f.incoming.sub_order_id}-3` }, f.ctx),
  ]);
  expect(results.every((r) => r.kind === 'dropped')).toBe(true);
  const s = await snapshot(db, f.ctx.app_id);
  expect(s.dropKeys).toHaveLength(3);
  expect(s.drops).toEqual([expect.objectContaining({ count: 3n, reason: 'PID_NOT_OURS' })]);
  expect(s.orders).toEqual([]);
});

it('[AC-B1-08h#53] 每事务第一条业务 SQL 取 xact 锁，然后读 order_keys；orders 不写 rebate_status', async () => {
  const f = await fixture(db);
  const trace = traceQueries(db);
  const p = await pipeline({ ...f.deps, db: trace.db });
  trace.queries.length = 0;
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  expect(trace.queries[0]?.sql.toLowerCase()).toMatch(
    /select\s+pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(/,
  );
  expect(trace.queries[0]?.parameters).toContain(`orders.order_key:pdd:${f.incoming.sub_order_id}`);
  expect(trace.queries[1]?.sql.toLowerCase()).toMatch(/select.*order_keys/);
  const inserts = trace.queries.filter((q) => /insert into "app"\."orders"/.test(q.sql));
  expect(inserts).toHaveLength(1);
  expect(inserts[0]?.sql).not.toContain('rebate_status');
  trace.queries.length = 0;
  expect(await p.process({ ...f.incoming, raw_payload_id: '202' }, f.ctx)).toMatchObject({
    kind: 'unchanged',
  });
  expect(trace.queries.filter((q) => /\b(insert|update|delete)\b/i.test(q.sql))).toEqual([]);
});

it.each(['process', 'shared-helper'] as const)(
  '[AC-B1-08h#54] %s 与另一连接的标准锁互斥，释放后才完成',
  async (target) => {
    const f = await fixture(db);
    // Construct first so a NotImplemented factory is asserted before acquiring a DB lock.
    const applicationName = `attr-lock-${f.ctx.requestId}`;
    const contenderDb = createDb({
      connectionString: database!.urlFor('couli_app'),
      max: 1,
      applicationName,
    });
    let release: (() => void) | undefined;
    let holding: Promise<void> | undefined;
    let contender: Promise<unknown> | undefined;
    try {
      const p = await pipeline({ ...f.deps, db: contenderDb });
      const gate = Promise.withResolvers<void>();
      const locked = Promise.withResolvers<void>();
      release = () => gate.resolve();
      holding = db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`orders.order_key:pdd:${f.incoming.sub_order_id}`}, 0))`.execute(
          trx,
        );
        locked.resolve();
        await gate.promise;
      });
      await Promise.race([locked.promise, holding]);
      let finished = false;
      contender = capture(async () => {
        try {
          if (target === 'process') return await p.process(f.incoming, f.ctx);
          await contenderDb
            .transaction()
            .execute((trx) => lockOrderKey(trx, 'pdd', f.incoming.sub_order_id!));
          return { kind: 'locked' };
        } finally {
          finished = true;
        }
      });
      await expect
        .poll(
          async () => {
            if (finished) return 'completed-before-unlock';
            const waiters = await sql<{ n: bigint }>`
          select count(*)::bigint as n from pg_locks l
          join pg_stat_activity a on a.pid = l.pid
          where a.application_name = ${applicationName} and l.locktype = 'advisory' and not l.granted
        `.execute(db);
            return waiters.rows[0]?.n === 1n ? 'blocked' : 'starting';
          },
          { timeout: 5_000, interval: 20 },
        )
        .toBe('blocked');
      expect(finished).toBe(false);
      expect(f.findPid).not.toHaveBeenCalled();
      release();
      await holding;
      expect(await contender).toMatchObject({
        ok: true,
        value: { kind: target === 'process' ? 'inserted' : 'locked' },
      });
    } finally {
      release?.();
      await holding;
      await contender;
      await destroyDb(contenderDb);
    }
  },
);
