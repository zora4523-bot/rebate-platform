// B1-11t / D10-118 / BR-CALC-12: relation created_at and at carry one Clock instant.
// Use the existing writer as the red baseline; no implementation or frozen tests are changed.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  appendLevelChange,
  appendRelationChange,
  createGrowthHistory,
  type RelationChangeSource,
} from '../../../../apps/api/src/modules/growth/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import {
  bindParent,
  capturedLogger,
  levelLogs,
  newAppId,
  registerLevel,
  relationLogs,
  seedUser,
  shift,
} from '../change-logs/kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;

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

const cases: {
  title: string;
  source: RelationChangeSource;
  hadParent: boolean;
  unbind: boolean;
}[] = [
  { title: '[AC-B1-11t#1] 绑定', source: 'landing', hadParent: false, unbind: false },
  { title: '[AC-B1-11t#2] 改绑', source: 'admin', hadParent: true, unbind: false },
  { title: '[AC-B1-11t#3] 管理员解除', source: 'admin', hadParent: true, unbind: true },
  { title: '[AC-B1-11t#4] 上级注销解除', source: 'parent_deleted', hadParent: true, unbind: true },
];

it.each(cases)('$title：提交后 created_at 与注入 Clock 的 at 逐毫秒相等', async (testCase) => {
  const app = newAppId();
  const user = await seedUser(db, app);
  const oldParent = await seedUser(db, app);
  const newParent = await seedUser(db, app);
  const clock = new FixedClock('2026-10-10T10:00:00.789+08:00');
  const at = clock.now();
  const from = testCase.hadParent ? oldParent : null;
  const to = testCase.unbind ? null : newParent;
  const history = createGrowthHistory({ logger: capturedLogger().logger });

  await db.transaction().execute(async (trx) => {
    if (testCase.hadParent) {
      await appendRelationChange(trx, bindParent(app, user, null, oldParent, shift(at, -60_000)));
    }
    await appendRelationChange(trx, {
      ...bindParent(app, user, from, to, at),
      source: testCase.source,
      operator: testCase.source === 'parent_deleted' ? 'system' : `admin:${user}`,
    });
  });

  const rows = await relationLogs(db, app);
  expect(rows).toHaveLength(testCase.hadParent ? 2 : 1);
  expect(rows.at(-1)).toMatchObject({
    app_id: app,
    user_id: user,
    from_parent_id: from,
    to_parent_id: to,
    source: testCase.source,
    at,
  });
  expect(await history.parentAt(db, { app_id: app, user_id: user, at: shift(at, -1) })).toBe(from);
  expect(await history.parentAt(db, { app_id: app, user_id: user, at })).toBe(to);
  for (const row of rows) {
    expect(row.created_at.getTime()).toBe(row.at.getTime());
  }
  expect(rows.at(-1)!.created_at.getTime()).toBe(at.getTime());
});

it('[AC-B1-11t#5] 事务开始 < paid_at < at：按 at 与按 created_at 回放均不提前生效', async () => {
  const app = newAppId();
  const user = await seedUser(db, app);
  const parent = await seedUser(db, app);
  const history = createGrowthHistory({ logger: capturedLogger().logger });

  await db.transaction().execute(async (trx) => {
    const start = await sql<{ at: Date }>`SELECT transaction_timestamp() AS at`.execute(trx);
    expect(start.rows).toHaveLength(1);
    const transactionAt = start.rows[0]!.at;
    // Derive a deterministic injected clock from the observed transaction start. No sleeps or
    // assumptions about host/PG clock skew; offsets also avoid PG microsecond truncation edges.
    const clock = new FixedClock(shift(transactionAt, 60_000));
    const at = clock.now();
    const paidAt = shift(transactionAt, 30_000);
    expect(transactionAt.getTime()).toBeLessThan(paidAt.getTime());
    expect(paidAt.getTime()).toBeLessThan(at.getTime());

    await appendRelationChange(trx, bindParent(app, user, null, parent, at));
    for (const [queryAt, expected] of [
      [paidAt, null],
      [at, parent],
    ] as const) {
      const byAt = await history.parentAt(trx, { app_id: app, user_id: user, at: queryAt });
      const byCreatedAt = await sql<{ to_parent_id: string | null }>`
        SELECT to_parent_id FROM app.relation_change_logs
        WHERE app_id = ${app} AND user_id = ${user} AND created_at <= ${queryAt}
        ORDER BY created_at DESC, id DESC LIMIT 1
      `.execute(trx);
      expect(byAt).toBe(expected);
      expect(byCreatedAt.rows[0]?.to_parent_id ?? null).toBe(expected);
      expect(byCreatedAt.rows[0]?.to_parent_id ?? null).toBe(byAt);
    }
    const rows = await relationLogs(trx, app);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.at.getTime()).toBe(at.getTime());
    expect(rows[0]!.created_at.getTime()).toBe(at.getTime());
    expect(rows[0]!.created_at.getTime()).not.toBe(transactionAt.getTime());
    // The writer must still participate in the caller's transaction.
    expect(await relationLogs(db, app)).toEqual([]);
  });
});

it('[AC-B1-11t#6] 同步关系两列不影响其他 app、用户与等级日志的数据库默认时间', async () => {
  const app = newAppId();
  const otherApp = newAppId();
  const user = await seedUser(db, app);
  const otherUser = await seedUser(db, app);
  const parent = await seedUser(db, app);
  const otherAppUser = await seedUser(db, otherApp);
  const otherAppParent = await seedUser(db, otherApp);
  const clock = new FixedClock('2026-10-10T10:00:00.123+08:00');
  const at = clock.now();
  const history = createGrowthHistory({ logger: capturedLogger().logger });

  await db.transaction().execute(async (trx) => {
    await appendRelationChange(trx, bindParent(app, otherUser, null, parent, shift(at, 1)));
    await appendRelationChange(
      trx,
      bindParent(otherApp, otherAppUser, null, otherAppParent, shift(at, 2)),
    );
  });
  const beforeOtherUser = await relationLogs(db, app);
  const beforeOtherApp = await relationLogs(db, otherApp);

  await db.transaction().execute(async (trx) => {
    await appendLevelChange(trx, registerLevel(app, user, 'L2', at));
    await appendRelationChange(trx, bindParent(app, user, null, parent, at));

    const levels = await levelLogs(trx, app);
    expect(levels).toHaveLength(1);
    expect(levels[0]!.effective_at.getTime()).toBe(at.getTime());
    expect(levels[0]!.created_at.getTime()).not.toBe(at.getTime());
    // Compare inside PostgreSQL too: JS Date alone would hide sub-millisecond differences.
    const defaults = await sql<{ uses_default: boolean }>`
      SELECT created_at = transaction_timestamp() AS uses_default
      FROM app.level_change_logs WHERE app_id = ${app} AND user_id = ${user}
    `.execute(trx);
    expect(defaults.rows).toEqual([{ uses_default: true }]);
    expect(await history.levelAt(trx, { app_id: app, user_id: user, at })).toEqual({
      level: 'L2',
      missing: false,
    });
  });

  const all = await relationLogs(db, app);
  expect(all.filter((row) => row.user_id === otherUser)).toEqual(beforeOtherUser);
  expect(await relationLogs(db, otherApp)).toEqual(beforeOtherApp);
  const after = shift(at, 1_000);
  expect(await history.parentAt(db, { app_id: app, user_id: user, at: after })).toBe(parent);
  expect(await history.parentAt(db, { app_id: app, user_id: otherUser, at: after })).toBe(parent);
  expect(await history.parentAt(db, { app_id: otherApp, user_id: user, at: after })).toBeNull();
  expect(await history.parentAt(db, { app_id: app, user_id: otherAppUser, at: after })).toBeNull();
  expect(await history.parentAt(db, { app_id: otherApp, user_id: otherAppUser, at: after })).toBe(
    otherAppParent,
  );
  const target = all.filter((row) => row.user_id === user);
  expect(target).toHaveLength(1);
  expect(target[0]!.at.getTime()).toBe(at.getTime());
  expect(target[0]!.created_at.getTime()).toBe(at.getTime());
});
