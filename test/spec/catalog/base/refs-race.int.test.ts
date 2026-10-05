import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { enabled, instant, reference, setup, stored } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});
afterAll(async () => {
  await destroyDb(db);
  await database.drop();
});

// 补充 #4：两条固定连接，持锁者同时观察等待者，不用第三条连接或睡眠猜顺序。
// 第一条已写但未提交：普通 SELECT 仍可读到基线，而写入/锁定读取必须等提交。
// 因此「SELECT 后无条件 UPDATE」在新先旧后的顺序下会确定性覆盖新响应。
it.each(['new-first', 'old-first'] as const)(
  '[AC-B1-05c#37] BR-PROD-05 双连接事务屏障 %s 提交顺序仍只保留最新响应',
  async (order) => {
    const initial = setup(db);
    const baseline = reference({ appId: `review-race-${order}` });
    await initial.catalog.registerProductRef(baseline, enabled);
    const older = reference({
      appId: baseline.appId,
      rawItemId: 'OLDER-K1',
      rawFetchedAt: instant(10),
      receivedAt: instant(10),
      source: 'detail',
      title: '较旧标题',
      shopId: 'older-shop',
      canonicalUrl: 'https://example.com/older',
    });
    const newer = reference({
      appId: baseline.appId,
      rawItemId: 'NEWER-K1',
      rawFetchedAt: instant(20),
      receivedAt: instant(20),
      source: 'parse',
      title: '较新标题',
      shopId: 'newer-shop',
      shopType: 'tmall',
      canonicalUrl: 'https://example.com/newer',
    });
    const first = order === 'new-first' ? newer : older;
    const second = order === 'new-first' ? older : newer;
    const holder = await db.startTransaction().setIsolationLevel('read committed').execute();
    try {
      await sql`SET LOCAL statement_timeout = '10s'`.execute(holder);
      const firstContext = setup(holder);
      firstContext.clock.advanceMs(20);
      await firstContext.catalog.registerProductRef(first, enabled);
      await db.connection().execute(async (waiter) => {
        await sql`SET statement_timeout = '10s'`.execute(waiter);
        const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(waiter);
        const secondContext = setup(waiter);
        secondContext.clock.advanceMs(20);
        // 立即收集异常，失败清理时也必须等在途登记结束才能归还连接。
        const pending = secondContext.catalog.registerProductRef(second, enabled).then(
          () => ({ status: 'fulfilled' as const }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );
        try {
          await expect
            .poll(
              async () => {
                const result = await sql<{ blocked: boolean }>`
                  SELECT pg_backend_pid() = ANY(pg_blocking_pids(${pid.rows[0]!.pid})) AS blocked
                `.execute(holder);
                return result.rows[0]?.blocked;
              },
              { timeout: 5_000, interval: 10 },
            )
            .toBe(true);
          // 真正观察到第二条连接等待第一条的行锁后才允许提交。
          await holder.commit().execute();
          expect(await pending).toEqual({ status: 'fulfilled' });
        } finally {
          if (!holder.isCommitted && !holder.isRolledBack) await holder.rollback().execute();
          await pending;
          await sql`RESET statement_timeout`.execute(waiter);
        }
      });
    } finally {
      if (!holder.isCommitted && !holder.isRolledBack) await holder.rollback().execute();
    }
    expect(await initial.catalog.readProductRef(newer)).toEqual(newer);
    expect(await stored(db, newer.appId, newer.productKey)).toMatchObject([
      {
        raw_item_id: newer.rawItemId,
        raw_fetched_at: new Date(newer.rawFetchedAt),
        refreshed_at: new Date(newer.receivedAt),
        source: newer.source,
        title: newer.title,
        shop_id: newer.shopId,
        shop_type: newer.shopType,
        canonical_url: newer.canonicalUrl,
      },
    ]);
  },
  30_000,
);
