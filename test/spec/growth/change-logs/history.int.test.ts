// B1-11b readers: levelAt / parentAt replay the change logs at an instant (BR-INV-11, BR-INV-14,
// BR-CALC-12 and its 细则 examples). Rows are seeded through the growth writers, so the tables are
// touched only after a growth call has succeeded; the history is built inside each test body.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely, Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  LevelChangeInput,
  RelationChangeInput,
} from '../../../../apps/api/src/modules/growth/index.ts';
import {
  adminLevel,
  bindParent,
  capturedLogger,
  instant,
  missingWarnings,
  newAppId,
  registerLevel,
  rolledBack,
  seedUser,
  shift,
} from './kit.ts';

const growth = await import('../../../../apps/api/src/modules/growth/index.ts');

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

async function write(
  levels: readonly LevelChangeInput[],
  relations: readonly RelationChangeInput[] = [],
): Promise<void> {
  // One transaction per row: ids grow in the listed order.
  for (const input of levels) {
    await db.transaction().execute((trx) => growth.appendLevelChange(trx, input));
  }
  for (const input of relations) {
    await db.transaction().execute((trx) => growth.appendRelationChange(trx, input));
  }
}

const MINUTE = 60_000;

it('[AC-B1-11b#9] levelAt 取 effective_at ≤ T 的最新一条：09:59 按 L1，恰 10:00 按 L2（等号取新等级）', async () => {
  const { logger, entries } = capturedLogger();
  const history = growth.createGrowthHistory({ logger });
  const app = newAppId();
  const user = await seedUser(db, app);
  const registered = instant('2026-10-01T09:00:00.000+08:00');
  const promoted = instant('2026-10-20T10:00:00.000+08:00');
  const raised = instant('2026-10-25T10:00:00.000+08:00');
  await write([
    registerLevel(app, user, 'L1', registered),
    adminLevel(app, user, 'L1', 'L2', promoted),
    adminLevel(app, user, 'L2', 'L3', raised),
  ]);
  const at = (t: Date) => history.levelAt(db, { app_id: app, user_id: user, at: t });
  expect(await at(registered)).toEqual({ level: 'L1', missing: false });
  expect(await at(instant('2026-10-20T09:59:00.000+08:00'))).toEqual({
    level: 'L1',
    missing: false,
  });
  expect(await at(shift(promoted, -1))).toEqual({ level: 'L1', missing: false });
  expect(await at(promoted)).toEqual({ level: 'L2', missing: false });
  expect(await at(shift(raised, -MINUTE))).toEqual({ level: 'L2', missing: false });
  expect(await at(raised)).toEqual({ level: 'L3', missing: false });
  expect(await at(instant('2027-01-01T00:00:00.000+08:00'))).toEqual({
    level: 'L3',
    missing: false,
  });
  expect(missingWarnings(entries(), app, user)).toEqual([]);
});

it('[AC-B1-11b#10] T 早于全部等级日志：取 L1、missing=true，并告警一次（不取首条记录的等级）', async () => {
  const { logger, entries } = capturedLogger();
  const history = growth.createGrowthHistory({ logger });
  const app = newAppId();
  const user = await seedUser(db, app, 'L3');
  const registered = instant('2026-10-05T12:00:00.000+08:00');
  await write([registerLevel(app, user, 'L3', registered)]);
  expect(
    await history.levelAt(db, { app_id: app, user_id: user, at: shift(registered, -1) }),
  ).toEqual({ level: 'L1', missing: true });
  expect(missingWarnings(entries(), app, user)).toHaveLength(1);
  expect(await history.levelAt(db, { app_id: app, user_id: user, at: registered })).toEqual({
    level: 'L3',
    missing: false,
  });
  expect(missingWarnings(entries(), app, user)).toHaveLength(1);
});

it('[AC-B1-11b#11] 无任何等级日志：取 L1、missing=true，每次查询告警一次，日志带 app_id 与 user_id', async () => {
  const { logger, entries } = capturedLogger();
  const history = growth.createGrowthHistory({ logger });
  const app = newAppId();
  // users.level is L3, but growth never reads users: the fallback is the L1 literal.
  const user = await seedUser(db, app, 'L3');
  const query = { app_id: app, user_id: user, at: instant('2026-10-20T10:00:00.000+08:00') };
  expect(await history.levelAt(db, query)).toEqual({ level: 'L1', missing: true });
  const warned = missingWarnings(entries(), app, user);
  expect(warned).toHaveLength(1);
  expect(warned[0]).toMatchObject({ app_id: app, user_id: user });
  expect(await history.levelAt(db, query)).toEqual({ level: 'L1', missing: true });
  expect(missingWarnings(entries(), app, user)).toHaveLength(2);
});

it('[AC-B1-11b#12] 同一 effective_at 两条等级日志：取 id 大者（后写入的）', async () => {
  const { logger } = capturedLogger();
  const history = growth.createGrowthHistory({ logger });
  const app = newAppId();
  const user = await seedUser(db, app);
  const registered = instant('2026-10-01T09:00:00.000+08:00');
  const same = instant('2026-10-20T10:00:00.000+08:00');
  await write([
    registerLevel(app, user, 'L1', registered),
    adminLevel(app, user, 'L1', 'L3', same),
    adminLevel(app, user, 'L3', 'L2', same),
  ]);
  expect(await history.levelAt(db, { app_id: app, user_id: user, at: same })).toEqual({
    level: 'L2',
    missing: false,
  });
  expect(
    await history.levelAt(db, { app_id: app, user_id: user, at: shift(same, MINUTE) }),
  ).toEqual({ level: 'L2', missing: false });
});

it('[AC-B1-11b#13] 等级回放不串账号与 app：别的用户、别的 app_id 的日志都不算', async () => {
  const { logger, entries } = capturedLogger();
  const history = growth.createGrowthHistory({ logger });
  const app = newAppId();
  const otherApp = newAppId();
  const owner = await seedUser(db, app);
  const neighbour = await seedUser(db, app);
  const foreign = await seedUser(db, otherApp);
  const t0 = instant('2026-10-01T09:00:00.000+08:00');
  await write([
    registerLevel(app, owner, 'L2', t0),
    registerLevel(app, neighbour, 'L3', t0),
    registerLevel(otherApp, foreign, 'L3', t0),
  ]);
  const later = instant('2026-10-20T10:00:00.000+08:00');
  expect(await history.levelAt(db, { app_id: app, user_id: owner, at: later })).toEqual({
    level: 'L2',
    missing: false,
  });
  // The owner's id under another app has no log; the foreign user's id under this app neither.
  expect(await history.levelAt(db, { app_id: otherApp, user_id: owner, at: later })).toEqual({
    level: 'L1',
    missing: true,
  });
  expect(await history.levelAt(db, { app_id: app, user_id: foreign, at: later })).toEqual({
    level: 'L1',
    missing: true,
  });
  expect(missingWarnings(entries(), otherApp, owner)).toHaveLength(1);
  expect(missingWarnings(entries(), app, foreign)).toHaveLength(1);
});

it('[AC-B1-11b#14] 回放用每次调用传入的执行器：调用方事务里未提交的日志对该事务可见、对连接池不可见', async () => {
  const { logger } = capturedLogger();
  const history = growth.createGrowthHistory({ logger });
  const app = newAppId();
  const parent = await seedUser(db, app);
  const user = await seedUser(db, app);
  const t0 = instant('2026-10-10T10:00:00.000+08:00');
  const later = instant('2026-10-11T10:00:00.000+08:00');
  await rolledBack(db, async (trx: Transaction<DB>) => {
    await growth.appendLevelChange(trx, registerLevel(app, user, 'L3', t0));
    await growth.appendRelationChange(trx, bindParent(app, user, null, parent, t0));
    const query = { app_id: app, user_id: user, at: later };
    expect(await history.levelAt(trx, query)).toEqual({ level: 'L3', missing: false });
    expect(await history.parentAt(trx, query)).toBe(parent);
    expect(await history.levelAt(db, query)).toEqual({ level: 'L1', missing: true });
    expect(await history.parentAt(db, query)).toBeNull();
  });
});

it('[AC-B1-11b#15] parentAt 取 at ≤ T 的最新一条 to_parent_id：绑定前无上级，恰在绑定时刻取新上级', async () => {
  const { logger } = capturedLogger();
  const history = growth.createGrowthHistory({ logger });
  const app = newAppId();
  const first = await seedUser(db, app);
  const second = await seedUser(db, app);
  const user = await seedUser(db, app);
  const bound = instant('2026-10-10T10:00:00.000+08:00');
  const moved = instant('2026-10-15T10:00:00.000+08:00');
  await write(
    [],
    [bindParent(app, user, null, first, bound), bindParent(app, user, first, second, moved)],
  );
  const at = (t: Date) => history.parentAt(db, { app_id: app, user_id: user, at: t });
  expect(await at(shift(bound, -1))).toBeNull();
  expect(await at(bound)).toBe(first);
  expect(await at(shift(moved, -1))).toBe(first);
  expect(await at(moved)).toBe(second);
  expect(await at(instant('2027-01-01T00:00:00.000+08:00'))).toBe(second);
});

it('[AC-B1-11b#16] 解除记录（to_parent_id 为 null，含 admin 解除与 parent_deleted）之后 parentAt 为 null', async () => {
  const { logger } = capturedLogger();
  const history = growth.createGrowthHistory({ logger });
  const app = newAppId();
  const parent = await seedUser(db, app);
  const unbound = await seedUser(db, app);
  const orphaned = await seedUser(db, app);
  const bound = instant('2026-10-10T10:00:00.000+08:00');
  const removed = instant('2026-10-15T10:00:00.000+08:00');
  await write(
    [],
    [
      bindParent(app, unbound, null, parent, bound),
      bindParent(app, orphaned, null, parent, bound),
      bindParent(app, unbound, parent, null, removed),
      {
        app_id: app,
        user_id: orphaned,
        from_parent_id: parent,
        to_parent_id: null,
        source: 'parent_deleted',
        operator: 'system',
        reason: null,
        at: removed,
      },
    ],
  );
  for (const user of [unbound, orphaned]) {
    const at = (t: Date) => history.parentAt(db, { app_id: app, user_id: user, at: t });
    expect(await at(shift(removed, -1))).toBe(parent);
    expect(await at(removed)).toBeNull();
    expect(await at(shift(removed, MINUTE))).toBeNull();
  }
});

it('[AC-B1-11b#17] 无关系日志为无上级：parentAt 为 null；别的用户、别的 app_id 的记录不串', async () => {
  const { logger } = capturedLogger();
  const history = growth.createGrowthHistory({ logger });
  const app = newAppId();
  const otherApp = newAppId();
  const parent = await seedUser(db, app);
  const bound = await seedUser(db, app);
  const lonely = await seedUser(db, app);
  const foreignParent = await seedUser(db, otherApp);
  const foreign = await seedUser(db, otherApp);
  const t0 = instant('2026-10-10T10:00:00.000+08:00');
  await write(
    [],
    [
      bindParent(app, bound, null, parent, t0),
      bindParent(otherApp, foreign, null, foreignParent, t0),
    ],
  );
  const later = instant('2026-10-20T10:00:00.000+08:00');
  expect(await history.parentAt(db, { app_id: app, user_id: bound, at: later })).toBe(parent);
  expect(await history.parentAt(db, { app_id: app, user_id: lonely, at: later })).toBeNull();
  expect(await history.parentAt(db, { app_id: otherApp, user_id: bound, at: later })).toBeNull();
  expect(await history.parentAt(db, { app_id: app, user_id: foreign, at: later })).toBeNull();
});

it('[AC-B1-11b#18] 同一 at 两条关系日志：取 id 大者（后写入的）', async () => {
  const { logger } = capturedLogger();
  const history = growth.createGrowthHistory({ logger });
  const app = newAppId();
  const first = await seedUser(db, app);
  const second = await seedUser(db, app);
  const user = await seedUser(db, app);
  const same = instant('2026-10-10T10:00:00.000+08:00');
  await write(
    [],
    [bindParent(app, user, null, first, same), bindParent(app, user, first, second, same)],
  );
  expect(await history.parentAt(db, { app_id: app, user_id: user, at: same })).toBe(second);
});

it('[AC-B1-11b#19] 两跳取间推（BR-CALC-12 细则例）：B 于 10-10 绑定 A；C 的订单 10-09 间推无，10-11 间推 A', async () => {
  const { logger } = capturedLogger();
  const history = growth.createGrowthHistory({ logger });
  const app = newAppId();
  const a = await seedUser(db, app);
  const b = await seedUser(db, app);
  const c = await seedUser(db, app);
  await write(
    [],
    [
      bindParent(app, c, null, b, instant('2026-10-01T10:00:00.000+08:00')),
      bindParent(app, b, null, a, instant('2026-10-10T10:00:00.000+08:00')),
    ],
  );
  async function beneficiaries(paidAt: Date) {
    const direct = await history.parentAt(db, { app_id: app, user_id: c, at: paidAt });
    const indirect =
      direct === null
        ? null
        : await history.parentAt(db, { app_id: app, user_id: direct, at: paidAt });
    return { direct, indirect };
  }
  expect(await beneficiaries(instant('2026-10-09T12:00:00.000+08:00'))).toEqual({
    direct: b,
    indirect: null,
  });
  expect(await beneficiaries(instant('2026-10-11T12:00:00.000+08:00'))).toEqual({
    direct: b,
    indirect: a,
  });
});
