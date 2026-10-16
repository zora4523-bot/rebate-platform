// F1-10a §9.2 only. No API/audit/cache policy or additional admin FK is prescribed.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { column, columns, foreignKeys, keys, newAdmin } from '../../admin/kit.ts';
import { CHECK_VIOLATION, UNIQUE_VIOLATION, sqlState, unique } from '../kit.ts';
import { AT, NAMES, TABLE, history, insert, read, ready } from './kit.ts';

const ROLES = ['couli_app', 'couli_readonly', 'couli_payout'] as const;
let database: TestDatabase;
let app: Kysely<DB>;
const connections = new Map<(typeof ROLES)[number], Kysely<DB>>();

beforeAll(async () => {
  database = await createTestDatabase();
  for (const role of ROLES) {
    connections.set(role, createDb({ connectionString: database.urlFor(role), max: 2 }));
  }
  app = connections.get('couli_app')!;
});

afterAll(async () => {
  await Promise.all([...connections.values()].map((db) => destroyDb(db)));
  await database?.drop();
});

it('[AC-F1-10a#1] history columns preserve types and required/nullable fields', async () => {
  await ready(app);
  const actual = await columns(app, TABLE);
  expect(actual.map((c) => c.name).sort()).toEqual([...NAMES].sort());
  const types = {
    app_id: 'text',
    key: 'text',
    version: 'int4',
    value: 'jsonb',
    updated_by: 'text',
    updated_by_admin_id: (await column(app, 'admin_users', 'id')).type,
    reason: 'text',
    created_at: 'timestamptz',
  };
  for (const name of NAMES) {
    expect(
      actual.find((c) => c.name === name),
      name,
    ).toMatchObject({
      type: types[name],
      nullable: ['updated_by_admin_id', 'reason'].includes(name),
    });
  }
  expect(actual.find((c) => c.name === 'created_at')?.defaulted).toBe(true);
  expect((await keys(app, TABLE)).filter((k) => k.primary)).toEqual([
    { columns: ['app_id', 'key', 'version'], primary: true, partial: false, expression: false },
  ]);
});

it('[AC-F1-10a#2] omitted created_at is transaction now, optional actor and reason are NULL', async () => {
  await ready(app);
  const row = history();
  delete row.created_at;
  delete row.updated_by_admin_id;
  delete row.reason;
  await app.transaction().execute(async (trx) => {
    const time = await sql<{ now: Date }>`SELECT now() AS now`.execute(trx);
    await insert(trx, row);
    expect(await read(trx, row)).toEqual([
      {
        ...row,
        value: JSON.parse(String(row.value)),
        updated_by_admin_id: null,
        reason: null,
        created_at: time.rows[0]!.now,
      },
    ]);
  });
});

it('[AC-F1-10a#3] version rejects zero and negatives and accepts positive integer boundaries', async () => {
  await ready(app);
  for (const version of [0, -1, -2147483648]) {
    expect(await sqlState(insert(app, history({ version }))), String(version)).toBe(
      CHECK_VIOLATION,
    );
  }
  for (const version of [1, 7, 2147483647]) {
    expect(await sqlState(insert(app, history({ version }))), String(version)).toBe('no error');
  }
});

it('[AC-F1-10a#4] duplicate triples fail, while each primary-key component distinguishes rows', async () => {
  await ready(app);
  const row = history();
  await insert(app, row);
  expect(await sqlState(insert(app, { ...row, value: 'false' }))).toBe(UNIQUE_VIOLATION);
  for (const other of [
    { ...row, app_id: unique('other_app_') },
    { ...row, key: unique('other.key.') },
    { ...row, version: 2 },
  ]) {
    expect(await sqlState(insert(app, other))).toBe('no error');
  }
  expect(await read(app, row)).toEqual([{ ...row, value: JSON.parse(String(row.value)) }]);
});

it('[AC-F1-10a#5] JSON values and administrator/name/reason snapshots round-trip unchanged', async () => {
  await ready(app);
  const appId = unique('history_actor_');
  const admin = await newAdmin(app, { app_id: appId });
  for (const value of [
    'true',
    'false',
    '0',
    '"中文"',
    'null',
    '[]',
    '[1,null]',
    '{"nested":{"a":1}}',
  ]) {
    const row = history({
      app_id: appId,
      value,
      updated_by: '旧用户名快照',
      updated_by_admin_id: admin.id,
      reason: '恢复旧版本；保留原始说明',
    });
    await insert(app, row);
    expect(await read(app, row)).toEqual([{ ...row, value: JSON.parse(value) }]);
  }
});

it('[AC-F1-10a#6] history has no config_items FK and accepts the existing unconstrained key shapes', async () => {
  await ready(app);
  expect((await foreignKeys(app, TABLE)).filter((f) => f.target === 'config_items')).toEqual([]);
  // config_items currently has no key shape CHECK (db/schema.sql). In particular,
  // platform_icons' lowercase/underscore restriction must not leak into this table.
  for (const key of [
    '',
    'payout.enabled',
    'Mixed-Case key',
    '中文配置',
    'a'.repeat(256),
    'line\nkey',
  ]) {
    const row = history({ key });
    const current = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM app.config_items
      WHERE app_id = ${row.app_id} AND key = ${key}
    `.execute(app);
    expect(current.rows).toEqual([{ count: '0' }]);
    expect(await sqlState(insert(app, row)), key).toBe('no error');
  }
});

it('[AC-F1-10a#7] each role has exactly its allowed table privileges', async () => {
  await ready(app);
  for (const role of ROLES) {
    const grants = await sql<{ privilege: string; held: boolean }>`
      SELECT p AS privilege, has_table_privilege(${role}, 'app.config_item_versions', p) AS held
      FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p
    `.execute(app);
    expect(Object.fromEntries(grants.rows.map((r) => [r.privilege, r.held])), role).toEqual({
      SELECT: true,
      INSERT: role === 'couli_app',
      UPDATE: false,
      DELETE: false,
      TRUNCATE: false,
      REFERENCES: false,
      TRIGGER: false,
    });
    // Column-level grants can permit writes even when has_table_privilege is false.
    const columnGrants = await sql<{ insert: boolean; update: boolean }>`
      SELECT has_any_column_privilege(${role}, 'app.config_item_versions', 'INSERT') AS insert,
             has_any_column_privilege(${role}, 'app.config_item_versions', 'UPDATE') AS update
    `.execute(app);
    expect(columnGrants.rows, `${role} column grants`).toEqual([
      { insert: role === 'couli_app', update: false },
    ]);
  }
});

it('[AC-F1-10a#8] app inserts and all three roles read, but UPDATE and DELETE fail with 42501', async () => {
  await ready(app);
  const row = history();
  expect(await sqlState(insert(app, row))).toBe('no error');
  const expected = [{ ...row, value: JSON.parse(String(row.value)) }];
  for (const role of ROLES) {
    const db = connections.get(role)!;
    expect(await read(db, row), role).toEqual(expected);
    if (role !== 'couli_app') {
      expect(await sqlState(insert(db, history())), `${role} INSERT`).toBe('42501');
    }
    expect(
      await sqlState(
        sql`
        UPDATE app.config_item_versions SET value = 'false'::jsonb
        WHERE app_id = ${row.app_id} AND key = ${row.key} AND version = ${row.version}
      `.execute(db),
      ),
      `${role} UPDATE`,
    ).toBe('42501');
    expect(
      await sqlState(
        sql`
        DELETE FROM app.config_item_versions
        WHERE app_id = ${row.app_id} AND key = ${row.key} AND version = ${row.version}
      `.execute(db),
      ),
      `${role} DELETE`,
    ).toBe('42501');
  }
  expect(await read(app, row)).toEqual(expected);
});

it('[AC-F1-10a#9] kill switches remain config_items keys, with no separate kill_switches table', async () => {
  await ready(app);
  const tables = await sql<{ name: string | null }>`
    SELECT to_regclass('app.kill_switches')::text AS name
  `.execute(app);
  expect(tables.rows).toEqual([{ name: null }]);
  const row = history({ key: 'payout.enabled', value: 'false', created_at: AT });
  await insert(app, row);
  expect(await read(app, row)).toEqual([{ ...row, value: false }]);
});
