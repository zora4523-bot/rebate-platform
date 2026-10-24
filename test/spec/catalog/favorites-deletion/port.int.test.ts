// B1-28f: catalog's deletion cleanup port deleteFavoritesForUser on a real PostgreSQL as couli_app
// (08 BR-ID-28: 注销完成时「收藏全部删除」, D10-186 ⑤; orchestrator ruling D10-311 ②; brief B.1–B.4).
// The port is identity's DeletionCleanupStep: (trx, { appId, userId, at }) on the caller's
// transaction, which has already locked the users row; it never opens or commits a transaction,
// so a rollback of the caller takes the deletion back. Every favorite of the user in that app goes
// (all platforms, whatever their created_at); another user of the app and the same user_id in
// another app keep theirs. Re-entrant, also when two cleanups run at once.
// Only the orchestrator runs this file, with the shared integration global setup.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { deleteFavoritesForUser } from '../../../../apps/api/src/modules/catalog/index.ts';
import { member } from '../../identity/deletion-processing/kit.ts';
import { countOf } from '../favorites/db-kit.ts';
import { CLEANUP_AT, bounded, bystanders, fixture, lockUserRow, rolledBack, shift } from './kit.ts';

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
});

it('[AC-B1-28f#1] 删除该用户在本 app 的全部收藏（各平台、晚于 at 的也删），同 app 别的用户与别的 app 同 user_id 的收藏不动', async () => {
  const f = await fixture(db);
  expect(await countOf(db, f.appId, f.userId)).toBe(f.seeded);
  const before = await bystanders(db, f);
  await db.transaction().execute((trx) => deleteFavoritesForUser(trx, f.input));
  expect(await countOf(db, f.appId, f.userId)).toBe(0);
  expect(await bystanders(db, f)).toStrictEqual(before);
  expect(before.sameApp).toHaveLength(4);
  expect(before.otherApp).toHaveLength(2);
}, 30_000);

it('[AC-B1-28f#2] 按 app_id 限定：同一 user_id 配另一个 appId 只删那个 app 的收藏，本 app 的一条不少', async () => {
  const f = await fixture(db);
  const own = await bystanders(db, f);
  await db
    .transaction()
    .execute((trx) =>
      deleteFavoritesForUser(trx, { appId: f.otherAppId, userId: f.userId, at: CLEANUP_AT }),
    );
  expect(await countOf(db, f.otherAppId, f.userId)).toBe(0);
  expect(await countOf(db, f.appId, f.userId)).toBe(f.seeded);
  expect((await bystanders(db, f)).sameApp).toStrictEqual(own.sameApp);
}, 30_000);

it('[AC-B1-28f#3] 在调用方事务里执行（users 行已锁）：事务内即看不到收藏，提交前别的连接仍看到原样，提交后才删掉', async () => {
  const m = await member(db);
  const f = await fixture(db, { appId: m.appId, userId: m.uid });
  const before = await bystanders(db, f);
  await db.transaction().execute(async (trx) => {
    expect(await lockUserRow(trx, m.appId, m.uid)).toBe(1);
    await deleteFavoritesForUser(trx, f.input);
    expect(await countOf(trx, f.appId, f.userId)).toBe(0);
    // Not committed by the port: another connection still sees every row.
    expect(await countOf(db, f.appId, f.userId)).toBe(f.seeded);
  });
  expect(await countOf(db, f.appId, f.userId)).toBe(0);
  expect(await bystanders(db, f)).toStrictEqual(before);
}, 30_000);

it('[AC-B1-28f#4] 调用方回滚则删除一并回滚：一条收藏都不少', async () => {
  const m = await member(db);
  const f = await fixture(db, { appId: m.appId, userId: m.uid });
  const before = await bystanders(db, f);
  await rolledBack(db, async (trx) => {
    expect(await lockUserRow(trx, m.appId, m.uid)).toBe(1);
    await deleteFavoritesForUser(trx, f.input);
    expect(await countOf(trx, f.appId, f.userId)).toBe(0);
  });
  expect(await countOf(db, f.appId, f.userId)).toBe(f.seeded);
  expect(await bystanders(db, f)).toStrictEqual(before);
}, 30_000);

it('[AC-B1-28f#5] 可重入：同一事务里再调、提交后另起事务再调都不报错，结果不变；本来没有收藏的用户也不报错', async () => {
  const f = await fixture(db);
  const before = await bystanders(db, f);
  // The port's result is ignored (DeletionCleanupStep): only that it settles without error counts.
  await db.transaction().execute(async (trx) => {
    await deleteFavoritesForUser(trx, f.input);
    await deleteFavoritesForUser(trx, { ...f.input, at: shift(CLEANUP_AT, 1) });
    expect(await countOf(trx, f.appId, f.userId)).toBe(0);
  });
  expect(await countOf(db, f.appId, f.userId)).toBe(0);
  await db
    .transaction()
    .execute((trx) => deleteFavoritesForUser(trx, { ...f.input, at: shift(CLEANUP_AT, 60_000) }));
  expect(await countOf(db, f.appId, f.userId)).toBe(0);
  expect(await bystanders(db, f)).toStrictEqual(before);

  const empty = await member(db);
  await db.transaction().execute(async (trx) => {
    expect(await lockUserRow(trx, empty.appId, empty.uid)).toBe(1);
    await deleteFavoritesForUser(trx, { appId: empty.appId, userId: empty.uid, at: CLEANUP_AT });
  });
  expect(await countOf(db, empty.appId, empty.uid)).toBe(0);
  expect(await bystanders(db, f)).toStrictEqual(before);
}, 30_000);

it('[AC-B1-28f#6] 并发两次清理同一用户：两边都成功，最终该用户收藏为空，别人的不动', async () => {
  const f = await fixture(db);
  const before = await bystanders(db, f);
  const start = Promise.withResolvers<void>();
  let arrived = 0;
  let barrierExpired = false;
  const timer = setTimeout(() => {
    barrierExpired = true;
    start.resolve();
  }, 5000);
  const cleanups = [0, 1].map(() =>
    db.transaction().execute(async (trx) => {
      try {
        // Bound lock waits too, so draining a failed implementation cannot hang teardown.
        await bounded(trx);
        arrived += 1;
        if (arrived === 2) start.resolve();
        await start.promise;
        if (barrierExpired) {
          throw new Error('Both cleanup transactions must reach the start barrier within 5s');
        }
        await deleteFavoritesForUser(trx, f.input);
        return countOf(trx, f.appId, f.userId);
      } finally {
        // A failing setup or NotImplemented must also release the other callback's barrier.
        start.resolve();
      }
    }),
  );
  let results: PromiseSettledResult<number>[];
  try {
    results = await Promise.allSettled(cleanups);
  } finally {
    clearTimeout(timer);
    start.resolve();
  }
  const rejected = results.filter((result) => result.status === 'rejected');
  if (rejected.length > 0) throw (rejected[0] as PromiseRejectedResult).reason;
  expect(results).toStrictEqual([
    { status: 'fulfilled', value: 0 },
    { status: 'fulfilled', value: 0 },
  ]);
  expect(await countOf(db, f.appId, f.userId)).toBe(0);
  expect(await bystanders(db, f)).toStrictEqual(before);
}, 30_000);
