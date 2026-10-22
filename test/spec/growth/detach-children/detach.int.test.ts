// B1-15n / D10-137: BR-ID-28 direct children, BR-INV-11 history, D10-118 log instant.
// Only the orchestrator runs this file, with the shared integration global setup.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  appendRelationChange,
  createGrowthHistory,
  detachChildrenOfDeleted,
} from '../../../../apps/api/src/modules/growth/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import {
  bindParent,
  capturedLogger,
  newAppId,
  relationLogs,
  rolledBack,
  seedUser,
  shift,
} from '../change-logs/kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
const at = new FixedClock('2026-10-22T12:34:56.789+08:00').now();
const boundAt = shift(at, -60_000);

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
});

afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

type Executor = Kysely<DB> | Transaction<DB>;

// All transactions use Kysely's callback API: rejection rolls back, and its connection
// provider releases in finally. Never let a concurrent callback outlive its test and race
// afterAll's pool shutdown; the concurrent case below drains BOTH callbacks in finally.
function users(executor: Executor, appId: string) {
  return executor
    .withSchema('app')
    .selectFrom('users')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

async function link(trx: Transaction<DB>, appId: string, userId: string, parentId: string) {
  await trx
    .withSchema('app')
    .updateTable('users')
    .set({
      parent_id: parentId,
      parent_bind_source: 'landing',
      parent_bound_at: boundAt,
      self_bind_used: true,
      row_version: 7,
      updated_at: boundAt,
    })
    .where('app_id', '=', appId)
    .where('id', '=', userId)
    .execute();
  await appendRelationChange(trx, bindParent(appId, userId, null, parentId, boundAt));
}

async function fixture() {
  const appId = newAppId();
  const otherAppId = newAppId();
  return db.transaction().execute(async (trx) => {
    const ancestor = await seedUser(trx, appId);
    const parent = await seedUser(trx, appId, 'L2');
    await link(trx, appId, parent, ancestor);
    const children = [];
    for (const level of ['L1', 'L2', 'L3']) {
      const child = await seedUser(trx, appId, level);
      await link(trx, appId, child, parent);
      children.push(child);
    }
    const grandchild = await seedUser(trx, appId);
    await link(trx, appId, grandchild, children[0]!);
    const unrelated = await seedUser(trx, appId);
    const otherParent = await seedUser(trx, otherAppId);
    const otherChild = await seedUser(trx, otherAppId);
    await link(trx, otherAppId, otherChild, otherParent);
    return { appId, otherAppId, parent, children, grandchild, unrelated };
  });
}

it('[AC-B1-15n#1] 多个直属下级同步解除关系，每人恰写一条完整日志且 created_at = at', async () => {
  const f = await fixture();
  const beforeUsers = await users(db, f.appId);
  const beforeLogs = await relationLogs(db, f.appId);
  const result = await db
    .transaction()
    .execute((trx) => detachChildrenOfDeleted(trx, { appId: f.appId, userId: f.parent, at }));

  expect(result).toStrictEqual({ detached: f.children.length });
  const afterUsers = await users(db, f.appId);
  for (const child of f.children) {
    const before = beforeUsers.find((row) => row.id === child)!;
    expect(afterUsers.find((row) => row.id === child)).toStrictEqual({
      ...before,
      parent_id: null,
      parent_bind_source: null,
      parent_bound_at: null,
      row_version: before.row_version + 1,
      updated_at: at,
    });
  }
  const afterLogs = await relationLogs(db, f.appId);
  expect(afterLogs.slice(0, beforeLogs.length)).toStrictEqual(beforeLogs);
  const added = afterLogs.slice(beforeLogs.length);
  expect(added).toHaveLength(f.children.length);
  expect(added.map((row) => row.user_id).sort()).toEqual([...f.children].sort());
  for (const child of f.children) {
    expect(added.find((row) => row.user_id === child)).toStrictEqual({
      id: expect.any(String),
      app_id: f.appId,
      user_id: child,
      from_parent_id: f.parent,
      to_parent_id: null,
      source: 'parent_deleted',
      operator: 'system',
      reason: null,
      at,
      created_at: at,
    });
  }
});

it('[AC-B1-15n#2] 孙辈、注销用户本人、无关用户和另一应用的用户及日志均不变', async () => {
  const f = await fixture();
  const before = await users(db, f.appId);
  const beforeLogs = await relationLogs(db, f.appId);
  const otherUsers = await users(db, f.otherAppId);
  const otherLogs = await relationLogs(db, f.otherAppId);

  await db
    .transaction()
    .execute((trx) => detachChildrenOfDeleted(trx, { appId: f.appId, userId: f.parent, at }));

  const untouched = before.filter((row) => !f.children.includes(row.id));
  expect((await users(db, f.appId)).filter((row) => !f.children.includes(row.id))).toStrictEqual(
    untouched,
  );
  expect(
    (await relationLogs(db, f.appId)).filter((row) => !f.children.includes(row.user_id)),
  ).toStrictEqual(beforeLogs.filter((row) => !f.children.includes(row.user_id)));
  expect(await users(db, f.otherAppId)).toStrictEqual(otherUsers);
  expect(await relationLogs(db, f.otherAppId)).toStrictEqual(otherLogs);
});

it('[AC-B1-15n#3] 同一 userId 配其他 appId 返回零，不跨应用解除关系', async () => {
  const f = await fixture();
  const before = await users(db, f.appId);
  const beforeLogs = await relationLogs(db, f.appId);
  const otherUsers = await users(db, f.otherAppId);
  const otherLogs = await relationLogs(db, f.otherAppId);
  // users.id is globally unique: use the SAME subject ID with the wrong app, not an invalid
  // duplicate primary key fixture. Missing app_id predicates would detach the real children.
  const result = await db
    .transaction()
    .execute((trx) => detachChildrenOfDeleted(trx, { appId: f.otherAppId, userId: f.parent, at }));

  expect(result).toStrictEqual({ detached: 0 });
  expect(await users(db, f.appId)).toStrictEqual(before);
  expect(await relationLogs(db, f.appId)).toStrictEqual(beforeLogs);
  expect(await users(db, f.otherAppId)).toStrictEqual(otherUsers);
  expect(await relationLogs(db, f.otherAppId)).toStrictEqual(otherLogs);
});

it('[AC-B1-15n#4] 同事务与提交后均可重入，返回零且不重复改行或写日志', async () => {
  const f = await fixture();
  await db.transaction().execute(async (trx) => {
    expect(await detachChildrenOfDeleted(trx, { appId: f.appId, userId: f.parent, at })).toEqual({
      detached: f.children.length,
    });
    const afterUsers = await users(trx, f.appId);
    const afterLogs = await relationLogs(trx, f.appId);
    expect(
      await detachChildrenOfDeleted(trx, { appId: f.appId, userId: f.parent, at: shift(at, 1) }),
    ).toStrictEqual({ detached: 0 });
    expect(await users(trx, f.appId)).toStrictEqual(afterUsers);
    expect(await relationLogs(trx, f.appId)).toStrictEqual(afterLogs);
  });
  const afterUsers = await users(db, f.appId);
  const afterLogs = await relationLogs(db, f.appId);
  expect(
    await db
      .transaction()
      .execute((trx) =>
        detachChildrenOfDeleted(trx, { appId: f.appId, userId: f.parent, at: shift(at, 60_000) }),
      ),
  ).toStrictEqual({ detached: 0 });
  expect(await users(db, f.appId)).toStrictEqual(afterUsers);
  expect(await relationLogs(db, f.appId)).toStrictEqual(afterLogs);
});

it('[AC-B1-15n#5] 调用方事务提交前对外不可见，回滚撤销全部用户与日志改动', async () => {
  const f = await fixture();
  const before = await users(db, f.appId);
  const beforeLogs = await relationLogs(db, f.appId);
  // This helper catches only its own rollback sentinel; NotImplemented must propagate.
  await rolledBack(db, async (trx) => {
    expect(await detachChildrenOfDeleted(trx, { appId: f.appId, userId: f.parent, at })).toEqual({
      detached: f.children.length,
    });
    const inside = await users(trx, f.appId);
    expect(inside.filter((row) => f.children.includes(row.id)).map((row) => row.parent_id)).toEqual(
      f.children.map(() => null),
    );
    expect(await relationLogs(trx, f.appId)).toHaveLength(beforeLogs.length + f.children.length);
    expect(await users(db, f.appId)).toStrictEqual(before);
    expect(await relationLogs(db, f.appId)).toStrictEqual(beforeLogs);
  });
  expect(await users(db, f.appId)).toStrictEqual(before);
  expect(await relationLogs(db, f.appId)).toStrictEqual(beforeLogs);
});

it('[AC-B1-15n#6] parentAt 在解除前仍为原上级，解除时刻及之后为 null', async () => {
  const f = await fixture();
  const history = createGrowthHistory({ logger: capturedLogger().logger });
  await db
    .transaction()
    .execute((trx) => detachChildrenOfDeleted(trx, { appId: f.appId, userId: f.parent, at }));

  for (const child of f.children) {
    const query = { app_id: f.appId, user_id: child };
    expect(await history.parentAt(db, { ...query, at: shift(at, -1) })).toBe(f.parent);
    expect(await history.parentAt(db, { ...query, at })).toBeNull();
    expect(await history.parentAt(db, { ...query, at: shift(at, 1) })).toBeNull();
  }
  expect(
    await history.parentAt(db, { app_id: f.appId, user_id: f.grandchild, at: shift(at, 1) }),
  ).toBe(f.children[0]);
});

it('[AC-B1-15n#7] 本来无直属下级时返回零，用户和已有日志保持原样', async () => {
  const f = await fixture();
  const before = await users(db, f.appId);
  const beforeLogs = await relationLogs(db, f.appId);
  expect(
    await db
      .transaction()
      .execute((trx) => detachChildrenOfDeleted(trx, { appId: f.appId, userId: f.unrelated, at })),
  ).toStrictEqual({ detached: 0 });
  expect(await users(db, f.appId)).toStrictEqual(before);
  expect(await relationLogs(db, f.appId)).toStrictEqual(beforeLogs);
});

it('[AC-B1-15n#8] 并发清理同一上级时总共只解除一次，每个下级只有一条注销日志', async () => {
  const f = await fixture();
  const before = await users(db, f.appId);
  const beforeLogs = await relationLogs(db, f.appId);
  const start = Promise.withResolvers<void>();
  let arrived = 0;
  let barrierExpired = false;
  const timer = setTimeout(() => {
    barrierExpired = true;
    start.resolve();
  }, 5000);
  const requests = [0, 1].map(() =>
    db.transaction().execute(async (trx) => {
      try {
        // Bound lock waits too, so draining a failed implementation cannot hang teardown.
        await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
        await sql`SET LOCAL statement_timeout = '10s'`.execute(trx);
        arrived += 1;
        if (arrived === 2) start.resolve();
        await start.promise;
        if (barrierExpired) {
          throw new Error('Both cleanup transactions must reach the start barrier within 5s');
        }
        return await detachChildrenOfDeleted(trx, { appId: f.appId, userId: f.parent, at });
      } finally {
        // A failing setup or NotImplemented must also release the other callback's barrier.
        start.resolve();
      }
    }),
  );
  let results: { detached: number }[];
  try {
    results = await Promise.all(requests);
  } finally {
    clearTimeout(timer);
    start.resolve();
    // Preserve the original failure while awaiting rollback and connection release for both.
    await Promise.allSettled(requests);
  }

  expect(results.map((result) => result.detached).sort((a, b) => a - b)).toEqual([
    0,
    f.children.length,
  ]);
  const after = await users(db, f.appId);
  for (const child of f.children) {
    expect(after.find((row) => row.id === child)).toMatchObject({
      parent_id: null,
      row_version: before.find((row) => row.id === child)!.row_version + 1,
    });
  }
  const added = (await relationLogs(db, f.appId)).slice(beforeLogs.length);
  expect(added).toHaveLength(f.children.length);
  expect(added.map((row) => row.user_id).sort()).toEqual([...f.children].sort());
  expect(added.every((row) => row.source === 'parent_deleted')).toBe(true);
});
