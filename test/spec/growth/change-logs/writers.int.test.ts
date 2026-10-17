// B1-11b writers: appendLevelChange / appendRelationChange insert into the caller's transaction,
// take the time from the caller, refuse caller bugs with a TypeError before any SQL, and let
// database errors through unchanged (BR-INV-11, BR-INV-14; migration 0041).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  LevelChangeInput,
  RelationChangeInput,
} from '../../../../apps/api/src/modules/growth/index.ts';
import {
  adminLevel,
  attempt,
  bindParent,
  instant,
  levelLogs,
  newAppId,
  registerLevel,
  relationLogs,
  rolledBack,
  seedUser,
  userSnapshot,
} from './kit.ts';

const growth = await import('../../../../apps/api/src/modules/growth/index.ts');

let database: TestDatabase | undefined;
let db: Kysely<DB>;

beforeAll(async () => {
  // Each file gets a fresh clone of the migrated template from the integration global setup.
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

const DAY = 24 * 60 * 60 * 1000;

it('[AC-B1-11b#1] 等级日志写在调用方事务内：提交前别的连接看不到，提交后各列等于入参', async () => {
  const app = newAppId();
  const user = await seedUser(db, app);
  const effective = instant('2026-10-20T10:00:00.000+08:00');
  const input = adminLevel(app, user, 'L1', 'L2', effective);
  await db.transaction().execute(async (trx) => {
    await growth.appendLevelChange(trx, input);
    expect(await levelLogs(trx, app)).toHaveLength(1);
    expect(await levelLogs(db, app)).toEqual([]);
  });
  const rows = await levelLogs(db, app);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    app_id: app,
    user_id: user,
    from_level: 'L1',
    to_level: 'L2',
    source: 'admin',
    operator: input.operator,
    reason: 'manual review',
  });
  expect(rows[0]!.effective_at.getTime()).toBe(effective.getTime());
});

it('[AC-B1-11b#2] 关系日志写在调用方事务内：提交前别的连接看不到，提交后各列等于入参', async () => {
  const app = newAppId();
  const parent = await seedUser(db, app);
  const user = await seedUser(db, app);
  const at = instant('2026-10-10T12:00:00.000+08:00');
  const input = bindParent(app, user, null, parent, at);
  await db.transaction().execute(async (trx) => {
    await growth.appendRelationChange(trx, input);
    expect(await relationLogs(trx, app)).toHaveLength(1);
    expect(await relationLogs(db, app)).toEqual([]);
  });
  const rows = await relationLogs(db, app);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    app_id: app,
    user_id: user,
    from_parent_id: null,
    to_parent_id: parent,
    source: 'landing',
    operator: `user:${user}`,
    reason: null,
  });
  expect(rows[0]!.at.getTime()).toBe(at.getTime());
});

it('[AC-B1-11b#3] 调用方回滚后两张日志表都没有行（写入端口不自开事务、不提交）', async () => {
  const app = newAppId();
  const parent = await seedUser(db, app);
  const user = await seedUser(db, app);
  const at = instant('2026-10-12T08:00:00.000+08:00');
  await rolledBack(db, async (trx) => {
    await growth.appendLevelChange(trx, registerLevel(app, user, 'L1', at));
    await growth.appendRelationChange(trx, bindParent(app, user, null, parent, at));
    expect(await levelLogs(trx, app)).toHaveLength(1);
    expect(await relationLogs(trx, app)).toHaveLength(1);
  });
  expect(await levelLogs(db, app)).toEqual([]);
  expect(await relationLogs(db, app)).toEqual([]);
});

it('[AC-B1-11b#4] effective_at 与 at 取调用方传入的瞬间（到毫秒），不取数据库 now()', async () => {
  const app = newAppId();
  const parent = await seedUser(db, app);
  const user = await seedUser(db, app);
  // Far from the database clock: a value taken from now() cannot match by accident.
  const levelAt = instant('2024-03-05T06:07:08.123Z');
  const relationAt = instant('2024-03-05T06:07:09.456Z');
  await db.transaction().execute(async (trx) => {
    await growth.appendLevelChange(trx, registerLevel(app, user, 'L2', levelAt));
    await growth.appendRelationChange(trx, bindParent(app, user, null, parent, relationAt));
  });
  const [level] = await levelLogs(db, app);
  const [relation] = await relationLogs(db, app);
  expect(level!.effective_at.getTime()).toBe(levelAt.getTime());
  expect(relation!.at.getTime()).toBe(relationAt.getTime());
  expect(level!.created_at.getTime() - levelAt.getTime()).toBeGreaterThan(DAY);
  expect(relation!.created_at.getTime() - relationAt.getTime()).toBeGreaterThan(DAY);
});

type LevelCase = { name: string; patch: (input: LevelChangeInput) => unknown };
const LEVEL_CASES: LevelCase[] = [
  { name: 'to_level 不在 user_level 内', patch: (i) => ({ ...i, to_level: 'L4' }) },
  { name: 'from_level 不在 user_level 内', patch: (i) => ({ ...i, from_level: 'L0' }) },
  { name: '未知 source', patch: (i) => ({ ...i, source: 'auto_promotion' }) },
  {
    name: 'register 带 from_level',
    patch: (i) => ({ ...i, source: 'register', from_level: 'L1', to_level: 'L2', reason: null }),
  },
  { name: 'admin 缺 from_level', patch: (i) => ({ ...i, from_level: null }) },
  { name: 'admin from_level 等于 to_level', patch: (i) => ({ ...i, from_level: 'L2' }) },
  { name: 'admin 无 reason', patch: (i) => ({ ...i, reason: null }) },
  { name: 'admin reason 只有空白', patch: (i) => ({ ...i, reason: ' \t ' }) },
  { name: 'operator 为空串', patch: (i) => ({ ...i, operator: '' }) },
  { name: 'operator 只有空白', patch: (i) => ({ ...i, operator: '   ' }) },
  {
    name: 'effective_at 是无效 Date',
    patch: (i) => ({ ...i, effective_at: new Date(Number.NaN) }),
  },
  {
    name: 'effective_at 是字符串',
    patch: (i) => ({ ...i, effective_at: '2026-10-20T02:00:00.000Z' }),
  },
  {
    name: '缺 effective_at（无默认时间）',
    patch: (i) => {
      const { effective_at: _omitted, ...rest } = i;
      void _omitted;
      return rest;
    },
  },
];

it.each(LEVEL_CASES)(
  '[AC-B1-11b#5] 等级日志非法入参（$name）抛 TypeError，不发 SQL、事务仍可用',
  async ({ patch }) => {
    const app = newAppId();
    const user = await seedUser(db, app);
    const valid = adminLevel(app, user, 'L1', 'L2', instant('2026-10-20T10:00:00.000+08:00'));
    const bad = patch(valid) as LevelChangeInput;
    await rolledBack(db, async (trx) => {
      await expect(attempt(() => growth.appendLevelChange(trx, bad))).rejects.toBeInstanceOf(
        TypeError,
      );
      // A statement that reached the database and failed would abort the transaction here.
      expect(await levelLogs(trx, app)).toEqual([]);
    });
  },
);

type RelationCase = {
  name: string;
  patch: (input: RelationChangeInput, ids: { user: string; other: string }) => unknown;
};
const RELATION_CASES: RelationCase[] = [
  { name: '未知 source', patch: (i) => ({ ...i, source: 'invite' }) },
  {
    name: 'from_parent_id 等于 to_parent_id',
    patch: (i, ids) => ({ ...i, from_parent_id: ids.other, to_parent_id: ids.other }),
  },
  {
    name: 'from 与 to 都为 null',
    patch: (i) => ({ ...i, from_parent_id: null, to_parent_id: null }),
  },
  { name: 'to_parent_id 是本人', patch: (i, ids) => ({ ...i, to_parent_id: ids.user }) },
  {
    name: 'parent_deleted 带非空 to_parent_id',
    patch: (i, ids) => ({
      ...i,
      source: 'parent_deleted',
      operator: 'system',
      from_parent_id: null,
      to_parent_id: ids.other,
    }),
  },
  { name: 'operator 为空串', patch: (i) => ({ ...i, operator: '' }) },
  { name: 'operator 只有空白', patch: (i) => ({ ...i, operator: ' \n ' }) },
  { name: 'at 是无效 Date', patch: (i) => ({ ...i, at: new Date(Number.NaN) }) },
  { name: 'at 是数字', patch: (i) => ({ ...i, at: 1_760_000_000_000 }) },
  {
    name: '缺 at（无默认时间）',
    patch: (i) => {
      const { at: _omitted, ...rest } = i;
      void _omitted;
      return rest;
    },
  },
];

it.each(RELATION_CASES)(
  '[AC-B1-11b#6] 关系日志非法入参（$name）抛 TypeError，不发 SQL、事务仍可用',
  async ({ patch }) => {
    const app = newAppId();
    const other = await seedUser(db, app);
    const user = await seedUser(db, app);
    const valid = bindParent(app, user, null, other, instant('2026-10-10T12:00:00.000+08:00'));
    const bad = patch(valid, { user, other }) as RelationChangeInput;
    await rolledBack(db, async (trx) => {
      await expect(attempt(() => growth.appendRelationChange(trx, bad))).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(await relationLogs(trx, app)).toEqual([]);
    });
  },
);

it('[AC-B1-11b#7] 同一账号第二条 register 日志：23505 原样抛出，不吞、不改写，首条保留', async () => {
  const app = newAppId();
  const user = await seedUser(db, app);
  const first = instant('2026-10-01T09:00:00.000+08:00');
  await db.transaction().execute(async (trx) => {
    await growth.appendLevelChange(trx, registerLevel(app, user, 'L1', first));
  });
  let caught: unknown = 'no error';
  await rolledBack(db, async (trx) => {
    try {
      await growth.appendLevelChange(
        trx,
        registerLevel(app, user, 'L2', instant('2026-10-02T09:00:00.000+08:00')),
      );
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toMatchObject({ code: '23505', constraint: 'level_change_logs_register_key' });
  const rows = await levelLogs(db, app);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ source: 'register', to_level: 'L1' });
});

it('[AC-B1-11b#8] 写日志不改 users：level、parent_id 及绑定列、row_version、updated_at 不变', async () => {
  const app = newAppId();
  const parent = await seedUser(db, app);
  const user = await seedUser(db, app, 'L1');
  const before = await userSnapshot(db, user);
  const at = instant('2026-10-15T10:00:00.000+08:00');
  await db.transaction().execute(async (trx) => {
    await growth.appendLevelChange(trx, registerLevel(app, user, 'L1', at));
    await growth.appendLevelChange(trx, adminLevel(app, user, 'L1', 'L3', at));
    await growth.appendRelationChange(trx, bindParent(app, user, null, parent, at));
  });
  expect(await levelLogs(db, app)).toHaveLength(2);
  expect(await relationLogs(db, app)).toHaveLength(1);
  const after = await userSnapshot(db, user);
  expect(after).toEqual(before);
  expect(after).toMatchObject({ level: 'L1', parent_id: null });
});
