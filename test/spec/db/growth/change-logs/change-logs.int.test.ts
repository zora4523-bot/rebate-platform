// B1-11a §9.3 adjudicated storage shape: relation replay uses at, not created_at.
// Scope: migration only; growth transaction orchestration and L1 warning belong to B1-11b.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { columns, newUser, sqlState, useDb } from '../../identity-sessions/kit.ts';
import { AT, BEFORE, LATER, MIDDLE, TABLES, fixture, insert, ready, replay } from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 });
  useDb(app);
});
afterAll(async () => {
  if (readonly) await destroyDb(readonly);
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

it('[AC-B1-11a#1] 两表列类型、可空性、identity 与业务时钟默认值符合裁定', async () => {
  for (const table of TABLES) {
    await ready(app, table);
    const fields = [
      ['id', 'int8', false, true],
      ['app_id', 'text', false, false],
      ['user_id', 'uuid', false, false],
      ...(table === 'relation_change_logs'
        ? [
            ['from_parent_id', 'uuid', true, false],
            ['to_parent_id', 'uuid', true, false],
          ]
        : [
            ['from_level', 'text', true, false],
            ['to_level', 'text', false, false],
          ]),
      ['source', 'text', false, false],
      ['operator', 'text', false, false],
      ['reason', 'text', true, false],
      [table === 'relation_change_logs' ? 'at' : 'effective_at', 'timestamptz', false, false],
      ['created_at', 'timestamptz', false, true],
    ].map(([name, type, nullable, hasDefault]) => ({ name, type, nullable, hasDefault }));
    expect(await columns(table)).toEqual(expect.arrayContaining(fields));
    expect(await columns(table)).toHaveLength(fields.length);
    const identity = await sql<{ identity_generation: string; column_default: string | null }>`
      SELECT identity_generation, column_default FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = ${table} AND column_name = 'id'
    `.execute(app);
    expect(identity.rows).toEqual([{ identity_generation: 'ALWAYS', column_default: null }]);
    const timestamp = await sql<{ column_default: string }>`SELECT column_default
      FROM information_schema.columns WHERE table_schema = 'app'
      AND table_name = ${table} AND column_name = 'created_at'`.execute(app);
    expect(timestamp.rows).toEqual([{ column_default: 'now()' }]);
    const saved = await insert(app, table, await fixture(table));
    expect(saved.rows[0]).toMatchObject({ id: expect.any(BigInt), created_at: expect.any(Date) });
  }
});

it('[AC-B1-11a#2] 主键、全部 CHECK 以及跨 app 外键有指定名称且有效，无级联', async () => {
  for (const table of TABLES) {
    await ready(app, table);
    const checks =
      table === 'relation_change_logs'
        ? ['source', 'change', 'not_self', 'parent_deleted', 'operator']
        : ['to_level', 'from_level', 'source', 'shape', 'admin_reason', 'operator'];
    const constraints = await sql<{ name: string; kind: string; valid: boolean; cols: string[] }>`
      SELECT c.conname::text AS name, c.contype::text AS kind, c.convalidated AS valid,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS cols
      FROM pg_constraint c WHERE c.conrelid = to_regclass(${`app.${table}`})`.execute(app);
    expect(constraints.rows).toEqual(
      expect.arrayContaining([
        { name: `${table}_pkey`, kind: 'p', valid: true, cols: ['id'] },
        ...checks.map((name) =>
          expect.objectContaining({ name: `${table}_${name}_check`, kind: 'c', valid: true }),
        ),
      ]),
    );
    const foreign = await sql<{
      name: string;
      cols: string[];
      target: string;
      target_cols: string[];
      update: string;
      delete: string;
      valid: boolean;
    }>`SELECT c.conname::text AS name,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS cols,
      c.confrelid::regclass::text AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord) AS target_cols,
      c.confupdtype::text AS update, c.confdeltype::text AS delete, c.convalidated AS valid
      FROM pg_constraint c WHERE c.conrelid = to_regclass(${`app.${table}`}) AND c.contype = 'f'
    `.execute(app);
    const keys =
      table === 'relation_change_logs'
        ? [
            ['user', 'user_id'],
            ['from_parent', 'from_parent_id'],
            ['to_parent', 'to_parent_id'],
          ]
        : [['user', 'user_id']];
    expect(foreign.rows).toHaveLength(keys.length);
    for (const [suffix, column] of keys) {
      expect(foreign.rows).toContainEqual({
        name: `${table}_${suffix}_fkey`,
        cols: ['app_id', column],
        target: 'app.users',
        target_cols: ['app_id', 'id'],
        update: 'a',
        delete: 'a',
        valid: true,
      });
    }
  }
});

it('[AC-B1-11a#3] 回放索引列序与注册部分唯一索引符合裁定', async () => {
  for (const table of TABLES) {
    await ready(app, table);
    const indexes = await sql<{
      name: string;
      cols: string[];
      unique: boolean;
      predicate: string | null;
    }>`
      SELECT c.relname::text AS name,
        ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true)
          FROM generate_series(1, i.indnkeyatts) k ORDER BY k) AS cols,
        i.indisunique AS unique, pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = to_regclass(${`app.${table}`}) AND i.indisvalid AND i.indisready
    `.execute(app);
    expect(indexes.rows).toContainEqual({
      name:
        table === 'relation_change_logs' ? `${table}_user_at_idx` : `${table}_user_effective_idx`,
      cols: ['app_id', 'user_id', table === 'relation_change_logs' ? 'at' : 'effective_at', 'id'],
      unique: false,
      predicate: null,
    });
    if (table === 'level_change_logs') {
      expect(indexes.rows).toContainEqual({
        name: 'level_change_logs_register_key',
        cols: ['app_id', 'user_id'],
        unique: true,
        predicate: "(source = 'register'::text)",
      });
    }
  }
});

it('[AC-B1-11a#4] 六种关系来源合法，允许初次绑定、换绑和解除', async () => {
  const table = 'relation_change_logs';
  await ready(app, table);
  const row = await fixture(table);
  const parent = row['to_parent_id'];
  for (const source of [
    'landing',
    'register',
    'backfill',
    'admin',
    'risk_same_device',
    'parent_deleted',
  ]) {
    const changes =
      source === 'parent_deleted' || source === 'risk_same_device'
        ? { from_parent_id: parent, to_parent_id: null }
        : {};
    expect(
      await sqlState(insert(app, table, { ...row, ...changes, source, reason: null })),
      source,
    ).toBe('no error');
  }
  expect(await sqlState(insert(app, table, { ...row, from_parent_id: await newUser() }))).toBe(
    'no error',
  );
  for (const source of ['landing', 'register', 'backfill', 'admin']) {
    expect(
      await sqlState(
        insert(app, table, { ...row, source, from_parent_id: parent, to_parent_id: null }),
      ),
    ).toBe('no error');
  }
});

it('[AC-B1-11a#5] 关系 CHECK 拒绝未知来源、无变化、自指、错误注销解除与空操作人', async () => {
  const table = 'relation_change_logs';
  await ready(app, table);
  const row = await fixture(table);
  for (const changes of [
    { source: 'unknown' },
    { source: '' },
    { source: 'REGISTER' },
    { from_parent_id: row['to_parent_id'] },
    { from_parent_id: null, to_parent_id: null },
    { to_parent_id: row['user_id'] },
    { source: 'parent_deleted' },
    { operator: '' },
    { operator: '   ' },
  ]) {
    expect(
      await sqlState(insert(app, table, { ...row, ...changes })),
      JSON.stringify(changes),
    ).toBe('23514');
  }
});

it('[AC-B1-11a#6] 等级允许 L1/L2/L3 注册、升降级以及任意非空审计身份', async () => {
  const table = 'level_change_logs';
  await ready(app, table);
  for (const to_level of ['L1', 'L2', 'L3']) {
    const row = await fixture(table);
    expect(
      await sqlState(
        insert(app, table, {
          ...row,
          source: 'register',
          from_level: null,
          to_level,
          reason: null,
          operator: 'system:registration',
        }),
      ),
    ).toBe('no error');
    for (const from_level of ['L1', 'L2', 'L3'].filter((level) => level !== to_level)) {
      expect(await sqlState(insert(app, table, { ...row, from_level, to_level }))).toBe('no error');
    }
  }
});

it('[AC-B1-11a#7] 等级 CHECK 拒绝非法等级、来源、注册形状与无理由调级', async () => {
  const table = 'level_change_logs';
  await ready(app, table);
  const row = await fixture(table);
  for (const changes of [
    { source: 'automatic' },
    { source: 'REGISTER' },
    { source: '' },
    { to_level: 'L4' },
    { from_level: 'L4' },
    { to_level: '' },
    { source: 'register' },
    { from_level: null },
    { from_level: 'L2' },
    { reason: null },
    { reason: '' },
    { reason: '   ' },
    { operator: '' },
    { operator: '   ' },
  ]) {
    expect(
      await sqlState(insert(app, table, { ...row, ...changes })),
      JSON.stringify(changes),
    ).toBe('23514');
  }
});

it('[AC-B1-11a#8] 必填审计字段拒绝 NULL，业务时刻必须显式写入', async () => {
  for (const table of TABLES) {
    await ready(app, table);
    const row = await fixture(table);
    const clock = table === 'relation_change_logs' ? 'at' : 'effective_at';
    const required = [
      'app_id',
      'user_id',
      'source',
      'operator',
      'created_at',
      clock,
      ...(table === 'level_change_logs' ? ['to_level'] : []),
    ];
    for (const column of required) {
      expect(
        await sqlState(insert(app, table, { ...row, [column]: null })),
        `${table}.${column}`,
      ).toBe('23502');
    }
    const omitted = { ...row };
    delete omitted[clock];
    expect(await sqlState(insert(app, table, omitted))).toBe('23502');
  }
});

it('[AC-B1-11a#9] 用户及新旧上级外键均拒绝不存在和跨 app 的用户', async () => {
  for (const table of TABLES) {
    await ready(app, table);
    const row = await fixture(table);
    const foreignUser = await newUser({ app_id: `other-${randomUUID()}` });
    const keys =
      table === 'relation_change_logs'
        ? ['user_id', 'from_parent_id', 'to_parent_id']
        : ['user_id'];
    for (const column of keys) {
      for (const id of [randomUUID(), foreignUser]) {
        expect(
          await sqlState(insert(app, table, { ...row, [column]: id })),
          `${table}.${column}`,
        ).toBe('23503');
      }
    }
    expect(await sqlState(insert(app, table, { ...row, app_id: `missing-${randomUUID()}` }))).toBe(
      '23503',
    );
    expect(await sqlState(insert(app, table, row))).toBe('no error');
  }
});

it('[AC-B1-11a#10] 注册唯一性由 PG 保证，同用户 admin 多条及其他 app 注册不受限', async () => {
  const table = 'level_change_logs';
  await ready(app, table);
  const row = await fixture(table);
  const register = { ...row, source: 'register', from_level: null, reason: null };
  expect(await sqlState(insert(app, table, register))).toBe('no error');
  expect(
    await sqlState(insert(app, table, { ...register, effective_at: LATER, to_level: 'L3' })),
  ).toBe('23505');
  expect(await sqlState(insert(app, table, row))).toBe('no error');
  expect(await sqlState(insert(app, table, row))).toBe('no error');
  for (const appId of ['couli', `other-${randomUUID()}`]) {
    const another = await fixture(table, appId);
    expect(
      await sqlState(insert(app, table, { ...another, source: 'register', from_level: null })),
    ).toBe('no error');
  }
  const concurrent = { ...(await fixture(table)), source: 'register', from_level: null };
  const results = await Promise.all([
    sqlState(insert(app, table, concurrent)),
    sqlState(insert(app, table, concurrent)),
  ]);
  expect(results.sort()).toEqual(['23505', 'no error']);
});

it('[AC-B1-11a#11] app 仅可追加读取，readonly 仅读取，无表级或列级改删授权', async () => {
  for (const table of TABLES) {
    await ready(app, table);
    const row = await fixture(table);
    const saved = (await insert(app, table, row)).rows;
    for (const [role, db] of [
      ['couli_app', app],
      ['couli_readonly', readonly],
    ] as const) {
      const selected = await sql`SELECT * FROM ${sql.table(`app.${table}`)}
        WHERE user_id = ${row['user_id']}`.execute(db);
      expect(selected.rows).toEqual(saved);
      expect(
        await sqlState(
          sql`UPDATE ${sql.table(`app.${table}`)} SET reason = 'rewritten'
        WHERE user_id = ${row['user_id']}`.execute(db),
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          sql`DELETE FROM ${sql.table(`app.${table}`)}
        WHERE user_id = ${row['user_id']}`.execute(db),
        ),
      ).toBe('42501');
      const privileges = await sql<{ privilege: string }>`SELECT p AS privilege
        FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
        WHERE has_table_privilege(${role}, ${`app.${table}`}, p)
          OR CASE WHEN p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
            THEN has_any_column_privilege(${role}, ${`app.${table}`}, p) ELSE false END
        ORDER BY p`.execute(app);
      expect(privileges.rows).toEqual(
        (role === 'couli_app' ? ['INSERT', 'SELECT'] : ['SELECT']).map((privilege) => ({
          privilege,
        })),
      );
    }
    expect(await sqlState(insert(readonly, table, row))).toBe('42501');
    expect(
      (
        await sql`SELECT * FROM ${sql.table(`app.${table}`)} WHERE user_id = ${row['user_id']}`.execute(
          app,
        )
      ).rows,
    ).toEqual(saved);
  }
});

it('[AC-B1-11a#12] 两表仅有指定的行级 BEFORE UPDATE/DELETE 触发器并复用拒绝函数', async () => {
  for (const table of TABLES) {
    await ready(app, table);
    const triggers = await sql<{
      name: string;
      events: number;
      enabled: string;
      function_schema: string;
      function_name: string;
      condition: string | null;
    }>`SELECT t.tgname::text AS name, t.tgtype::integer AS events, t.tgenabled::text AS enabled,
      n.nspname::text AS function_schema, p.proname::text AS function_name,
      pg_get_expr(t.tgqual, t.tgrelid) AS condition
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE t.tgrelid = to_regclass(${`app.${table}`}) AND NOT t.tgisinternal`.execute(app);
    // tgtype = ROW(1) | BEFORE(2) | DELETE(8) | UPDATE(16), without INSERT/TRUNCATE.
    expect(triggers.rows).toEqual([
      {
        name: `${table}_append_only`,
        events: 27,
        enabled: 'O',
        function_schema: 'app',
        function_name: 'reject_update_delete',
        condition: null,
      },
    ]);
  }
  // TODO(规划/11 §2.3): 实测属主改删返回 23001 — blocked on 测试工具不提供迁移角色连接。
  // Catalog binding is not a substitute for that owner-role behavioral check.
});

it('[AC-B1-11a#13] 关系按 at 回放，等号取新上级，同刻按 id 决胜并保留解除记录', async () => {
  const table = 'relation_change_logs';
  await ready(app, table);
  const row = await fixture(table);
  const parentA = row['to_parent_id'];
  const parentB = await newUser();
  const first = (await insert(app, table, { ...row, created_at: LATER })).rows;
  const second = (
    await insert(app, table, {
      ...row,
      from_parent_id: parentA,
      to_parent_id: parentB,
      created_at: BEFORE,
    })
  ).rows;
  const third = (
    await insert(app, table, {
      ...row,
      from_parent_id: parentB,
      to_parent_id: null,
      source: 'parent_deleted',
      at: LATER,
      created_at: BEFORE,
    })
  ).rows;
  expect(first).toHaveLength(1);
  // Late arrival: its larger id must not override a later business instant.
  const middle = (await insert(app, table, { ...row, at: MIDDLE })).rows;
  // A later row for another user and another app must not leak into this user's replay.
  await insert(app, table, await fixture(table));
  await insert(app, table, await fixture(table, `other-${randomUUID()}`));
  const user = String(row['user_id']);
  expect(await replay(app, table, 'couli', user, BEFORE)).toEqual([]);
  expect(await replay(app, table, 'couli', user, AT)).toEqual(second);
  expect(await replay(app, table, 'couli', user, MIDDLE)).toEqual(middle);
  expect(await replay(app, table, 'couli', user, LATER)).toEqual(third);
  expect(third[0]?.['to_parent_id']).toBeNull();
  expect(await replay(app, table, 'other', user, LATER)).toEqual([]);
});

it('[AC-B1-11a#14] 等级按 effective_at 回放，边界及同刻 id 正确且不依赖入库戳', async () => {
  const table = 'level_change_logs';
  await ready(app, table);
  const row = await fixture(table);
  await insert(app, table, {
    ...row,
    source: 'register',
    from_level: null,
    to_level: 'L1',
    created_at: LATER,
  });
  const second = (await insert(app, table, { ...row, created_at: BEFORE })).rows;
  const third = (
    await insert(app, table, {
      ...row,
      from_level: 'L2',
      to_level: 'L3',
      effective_at: LATER,
      created_at: BEFORE,
    })
  ).rows;
  const middle = (await insert(app, table, { ...row, effective_at: MIDDLE })).rows;
  await insert(app, table, await fixture(table));
  await insert(app, table, await fixture(table, `other-${randomUUID()}`));
  const user = String(row['user_id']);
  expect(await replay(app, table, 'couli', user, BEFORE)).toEqual([]);
  expect(await replay(app, table, 'couli', user, AT)).toEqual(second);
  expect(await replay(app, table, 'couli', user, MIDDLE)).toEqual(middle);
  expect(await replay(app, table, 'couli', user, LATER)).toEqual(third);
  expect(third[0]?.['to_level']).toBe('L3');
  expect(await replay(app, table, 'other', user, LATER)).toEqual([]);
});
