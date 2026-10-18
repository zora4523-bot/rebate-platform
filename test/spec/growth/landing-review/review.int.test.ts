import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { PostgresQueryCompiler, sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  AT,
  HASH,
  OTHER_HASH,
  assertHit,
  assertSilent,
  fixture,
  growth,
  hits,
  landing,
  loginLog,
  relationLogs,
  seedUser,
  user,
} from './kit.ts';

let database: TestDatabase;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  if (db) await destroyDb(db);
  if (database) await database.drop();
});

it('[AC-B1-11f#1] 邀请人任一保留登录记录命中：解除三列、保留机会已用、日志与风险各一行', async () => {
  const f = await fixture(db);
  await loginLog(db, f.appId, f.parentId, HASH);
  await loginLog(db, f.appId, f.parentId, OTHER_HASH);
  await loginLog(db, f.appId, f.parentId, HASH);
  const before = await user(db, f.appId, f.uid);
  const parent = await user(db, f.appId, f.parentId);
  const review = await f.reviewer();
  f.clock.advanceMs(12_345);
  await db.transaction().execute((trx) => review.review(trx, f.input));
  await assertHit(db, f.appId, f.uid, f.parentId, HASH, f.clock.now());
  expect(await user(db, f.appId, f.uid)).toEqual({
    ...before,
    parent_id: null,
    parent_bind_source: null,
    parent_bound_at: null,
    updated_at: f.clock.now(),
    row_version: before.row_version + 1,
  });
  expect(await user(db, f.appId, f.parentId)).toEqual(parent);
  await assertSilent(db, f.appId);
});

it('[AC-B1-11f#2] 本次设备不在邀请人集合内：即使被邀请人旧记录有交集也不解除且零写入', async () => {
  const f = await fixture(db);
  await loginLog(db, f.appId, f.parentId, OTHER_HASH);
  await loginLog(db, f.appId, f.uid, OTHER_HASH);
  const before = await user(db, f.appId, f.uid);
  // Direct port call fixes the BR-INV-09 invitee set to this request only; identity owns firstness.
  const read = vi.fn(f.deps.loginDevices.read);
  const record = vi.fn(f.deps.hitWriter.record);
  const review = await f.reviewer({ loginDevices: { read }, hitWriter: { record } });
  const start = f.statements.length;
  await f.db.transaction().execute((trx) => review.review(trx, f.input));
  expect(f.statements.slice(start).filter((s) => /\b(insert|update|delete)\b/i.test(s))).toEqual(
    [],
  );
  expect(read).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    app_id: f.appId,
    user_id: f.parentId,
  });
  expect(record).not.toHaveBeenCalled();
  expect(await user(db, f.appId, f.uid)).toEqual(before);
  expect(await relationLogs(db, f.appId)).toEqual([]);
  expect(await hits(db, f.appId)).toEqual([]);
});

it.each(['register', 'backfill', 'admin', null])(
  '[AC-B1-11f#3] 来源 %s 不属于落地页，不读设备、不写风险、不动关系',
  async (source) => {
    const f = await fixture(db);
    await db
      .withSchema('app')
      .updateTable('users')
      .set({ parent_bind_source: source })
      .where('id', '=', f.uid)
      .execute();
    await loginLog(db, f.appId, f.parentId, HASH);
    const before = await user(db, f.appId, f.uid);
    const read = vi.fn(f.deps.loginDevices.read);
    const record = vi.fn(f.deps.hitWriter.record);
    const review = await f.reviewer({ loginDevices: { read }, hitWriter: { record } });
    const start = f.statements.length;
    await f.db.transaction().execute((trx) => review.review(trx, f.input));
    expect(f.statements.slice(start).filter((s) => /\b(insert|update|delete)\b/i.test(s))).toEqual(
      [],
    );
    expect(read).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(await user(db, f.appId, f.uid)).toEqual(before);
    expect(await relationLogs(db, f.appId)).toEqual([]);
    expect(await hits(db, f.appId)).toEqual([]);
  },
);

it('[AC-B1-11f#4] app 隔离：别的应用或别的邀请人的相同设备不能误命中', async () => {
  const f = await fixture(db);
  const otherApp = `other_${randomUUID()}`;
  const foreignParent = await seedUser(db, otherApp);
  const foreignUser = await seedUser(db, otherApp);
  await landing(db, otherApp, foreignUser, foreignParent);
  await loginLog(db, otherApp, foreignParent, HASH);
  const unrelated = await seedUser(db, f.appId);
  await loginLog(db, f.appId, unrelated, HASH);
  const before = await user(db, f.appId, f.uid);
  const foreignBefore = await user(db, otherApp, foreignUser);
  const review = await f.reviewer();
  await db.transaction().execute((trx) => review.review(trx, f.input));
  expect(await user(db, f.appId, f.uid)).toEqual(before);
  expect(await relationLogs(db, f.appId)).toEqual([]);
  expect(await hits(db, f.appId)).toEqual([]);
  // Positive control also checks that the update cannot leak into another app.
  await loginLog(db, f.appId, f.parentId, HASH);
  await db.transaction().execute((trx) => review.review(trx, f.input));
  await assertHit(db, f.appId, f.uid, f.parentId, HASH, new Date(AT));
  expect(await user(db, otherApp, foreignUser)).toEqual(foreignBefore);
  expect(await relationLogs(db, otherApp)).toEqual([]);
  expect(await hits(db, otherApp)).toEqual([]);
});

it('[AC-B1-11f#5] 调用方未提交的邀请人登录可见，解除与两种日志随外层回滚', async () => {
  const f = await fixture(db);
  const review = await f.reviewer();
  const before = await user(db, f.appId, f.uid);
  const rollback = new Error('fixture caller rollback');
  await expect(
    db.transaction().execute(async (trx) => {
      await loginLog(trx, f.appId, f.parentId, HASH);
      await review.review(trx, f.input);
      await assertHit(trx, f.appId, f.uid, f.parentId, HASH, new Date(AT));
      expect(await user(db, f.appId, f.uid)).toEqual(before);
      expect(await relationLogs(db, f.appId)).toEqual([]);
      expect(await hits(db, f.appId)).toEqual([]);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await user(db, f.appId, f.uid)).toEqual(before);
  expect(await relationLogs(db, f.appId)).toEqual([]);
  expect(await hits(db, f.appId)).toEqual([]);
});

it.each(['relation_change_logs', 'risk_hits'] as const)(
  '[AC-B1-11f#6] %s 插入失败不能吞掉，关系和另一种日志一并回滚',
  async (table) => {
    const f = await fixture(db);
    await loginLog(db, f.appId, f.parentId, HASH);
    const before = await user(db, f.appId, f.uid);
    const review = await f.reviewer();
    const failure = new Error(`fixture failed ${table}`);
    const failed = vi.fn();
    const failing = db.withPlugin({
      transformQuery({ node, queryId }) {
        const statement = new PostgresQueryCompiler().compileQuery(node, queryId).sql;
        if (new RegExp(`insert\\s+into\\s+(?:"?app"?\\.)?"?${table}\\b`, 'i').test(statement)) {
          failed();
          throw failure;
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    await expect(failing.transaction().execute((trx) => review.review(trx, f.input))).rejects.toBe(
      failure,
    );
    expect(failed).toHaveBeenCalledTimes(1);
    expect(await user(db, f.appId, f.uid)).toEqual(before);
    expect(await relationLogs(db, f.appId)).toEqual([]);
    expect(await hits(db, f.appId)).toEqual([]);
  },
);

it('[AC-B1-11f#7] 同账号两个并发复核均成功返回，只解除一次且重复调用不追加', async () => {
  const f = await fixture(db);
  await loginLog(db, f.appId, f.parentId, HASH);
  const before = await user(db, f.appId, f.uid);
  const review = await f.reviewer();
  await Promise.all(
    [0, 1].map(() => db.transaction().execute((trx) => review.review(trx, f.input))),
  );
  await assertHit(db, f.appId, f.uid, f.parentId, HASH, new Date(AT));
  const after = await user(db, f.appId, f.uid);
  expect(after.row_version).toBe(before.row_version + 1);
  await db.transaction().execute((trx) => review.review(trx, f.input));
  expect(await user(db, f.appId, f.uid)).toEqual(after);
  await assertHit(db, f.appId, f.uid, f.parentId, HASH, new Date(AT));
});

it('[AC-B1-11f#8] 设备读取后上级已变化，旧上级命中不得解除新关系或写命中日志', async () => {
  const f = await fixture(db);
  const newParent = await seedUser(db, f.appId);
  await loginLog(db, f.appId, f.parentId, HASH);
  let changed = false;
  const record = vi.fn(f.deps.hitWriter.record);
  const review = await f.reviewer({
    hitWriter: { record },
    loginDevices: {
      async read(trx, subject) {
        const hashes = await f.deps.loginDevices.read(trx, subject);
        if (!changed && subject.user_id === f.parentId) {
          // Deterministic stale-read schedule, without a second connection waiting on our lock.
          await trx
            .withSchema('app')
            .updateTable('users')
            .set({ parent_id: newParent })
            .where('app_id', '=', f.appId)
            .where('id', '=', f.uid)
            .execute();
          changed = true;
        }
        return hashes;
      },
    },
  });
  const before = await user(db, f.appId, f.uid);
  await db.transaction().execute((trx) => review.review(trx, f.input));
  expect(changed).toBe(true);
  expect(await user(db, f.appId, f.uid)).toEqual({ ...before, parent_id: newParent });
  expect(record).not.toHaveBeenCalled();
  expect(await relationLogs(db, f.appId)).toEqual([]);
  expect(await hits(db, f.appId)).toEqual([]);
});

it('[AC-B1-11f#9] 命中写入前持有 app 关系锁，锁保持至调用方事务结束且不阻挡其他 app', async () => {
  const f = await fixture(db);
  await loginLog(db, f.appId, f.parentId, HASH);
  const { relationWriteLockKey } = await growth();
  const key = relationWriteLockKey(f.appId).toString();
  const other = relationWriteLockKey(`other_${f.appId}`).toString();
  async function available(lockKey: string) {
    return db.transaction().execute(
      async (trx) =>
        (
          await sql<{ acquired: boolean }>`
      SELECT pg_try_advisory_xact_lock(${lockKey}::bigint) AS acquired`.execute(trx)
        ).rows[0]!.acquired,
    );
  }
  const record = vi.fn<typeof f.deps.hitWriter.record>(async (trx, input) => {
    expect(await available(key)).toBe(false);
    expect(await available(other)).toBe(true);
    await f.deps.hitWriter.record(trx, input);
  });
  const review = await f.reviewer({ hitWriter: { record } });
  const start = f.statements.length;
  await f.db.transaction().execute(async (trx) => {
    await review.review(trx, f.input);
    expect(await available(key)).toBe(false);
  });
  const statements = f.statements.slice(start);
  const lockIndex = statements.findIndex((s) => /pg_advisory_xact_lock/.test(s));
  const updateIndex = statements.findIndex((s) => /^update\s+(?:"app"\.)?"users"/i.test(s));
  expect(lockIndex).toBeGreaterThanOrEqual(0);
  expect(updateIndex).toBeGreaterThan(lockIndex);
  expect(record).toHaveBeenCalledTimes(1);
  expect(await available(key)).toBe(true);
  await assertHit(db, f.appId, f.uid, f.parentId, HASH, new Date(AT));
});
