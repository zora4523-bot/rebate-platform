// F1-06zi §9: nullable display_name, character-count CHECK and additive column grants.
// Only the shared globalSetup reads the admin database URL; queries use business roles.
// Every case checks the column first, so an absent migration produces assertion reds.
// TODO(规划/11 §2.3): 在迁移前插入旧账号并验证迁移后为 NULL — blocked on
// createTestDatabase 只支持复制已迁移模板，当前任务不能改测试基础设施。
import { readdirSync, readFileSync } from 'node:fs';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { column, newAdmin } from '../kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
});

afterAll(async () => {
  await Promise.all([app, readonly].filter(Boolean).map((db) => destroyDb(db)));
  if (database) await database.drop();
});

async function ready() {
  return column(app, 'admin_users', 'display_name');
}

async function stored(id: unknown, db = app) {
  const result = await sql<{ display_name: string | null }>`
    SELECT display_name FROM app.admin_users WHERE id = ${id}
  `.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!.display_name;
}

async function displayNameChecks() {
  const result = await sql<{ name: string; definition: string; validated: boolean }>`
    SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS definition,
           c.convalidated AS validated
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'app.admin_users'::regclass AND c.contype = 'c'
      AND a.attname = 'display_name'
  `.execute(app);
  expect(result.rows.length, 'display_name has a database CHECK').toBeGreaterThan(0);
  return result.rows;
}

function migrationSource() {
  const directory = new URL('../../../../../db/migrations/', import.meta.url);
  const sources = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .map((name) =>
      readFileSync(new URL(name, directory), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\n]*/g, ' ')
        .replaceAll('"', ''),
    );
  // Discover the column addition, not a filename or a reserved migration number.
  const additions = sources.filter((source) =>
    /\bALTER\s+TABLE\s+(?:ONLY\s+)?app\s*\.\s*admin_users\b[^;]*\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?display_name\b/i.test(
      source,
    ),
  );
  expect(additions, 'one migration adds admin_users.display_name').toHaveLength(1);
  return additions[0]!;
}

const VALID_NAMES = ['a', '中', '𠀀', 'a'.repeat(32), '中'.repeat(32), '𠀀'.repeat(32)];

it('[AC-F1-06zi#1] display_name exists as nullable text', async () => {
  expect(await ready()).toMatchObject({ name: 'display_name', type: 'text', nullable: true });
});

it('[AC-F1-06zi#2] omitting display_name on INSERT stores NULL', async () => {
  // The fixture fills required columns, so establish nullability before using it.
  expect((await ready()).nullable).toBe(true);
  const row = await newAdmin(app);
  expect(row['display_name']).toBeNull();
  expect(await stored(row['id'])).toBeNull();
});

it('[AC-F1-06zi#3] INSERT accepts 1 and 32 characters including Chinese and supplementary characters', async () => {
  await ready();
  for (const value of VALID_NAMES) {
    const row = await newAdmin(app, { display_name: value });
    expect(row['display_name']).toBe(value);
    expect(await stored(row['id'])).toBe(value);
  }
});

it('[AC-F1-06zi#4] couli_app can UPDATE display_name to either length boundary without truncation', async () => {
  await ready();
  const row = await newAdmin(app);
  for (const value of VALID_NAMES) {
    const updated = await sql`
      UPDATE app.admin_users SET display_name = ${value} WHERE id = ${row['id']}
    `.execute(app);
    expect(updated.numAffectedRows).toBe(1n);
    expect(await stored(row['id'])).toBe(value);
  }
});

it('[AC-F1-06zi#5] explicit NULL is accepted on INSERT and clears an existing display_name on UPDATE', async () => {
  await ready();
  const empty = await newAdmin(app, { display_name: null });
  expect(empty['display_name']).toBeNull();
  expect(await stored(empty['id'])).toBeNull();
  const named = await newAdmin(app, { display_name: '处理人' });
  const updated = await sql`
    UPDATE app.admin_users SET display_name = NULL WHERE id = ${named['id']}
  `.execute(app);
  expect(updated.numAffectedRows).toBe(1n);
  expect(await stored(named['id'])).toBeNull();
});

async function rejectsName(value: string) {
  const checks = await displayNameChecks();
  const names = checks.map((c) => c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const violation = {
    code: '23514',
    constraint: expect.stringMatching(new RegExp(`^(?:${names})$`)),
  };
  await expect(newAdmin(app, { display_name: value })).rejects.toMatchObject(violation);
  const row = await newAdmin(app, { display_name: '原名' });
  await expect(
    sql`UPDATE app.admin_users SET display_name = ${value} WHERE id = ${row['id']}`.execute(app),
  ).rejects.toMatchObject(violation);
  expect(await stored(row['id'])).toBe('原名');
}

it('[AC-F1-06zi#6] empty strings fail the display_name CHECK on INSERT and UPDATE', async () => {
  await ready();
  await rejectsName('');
});

it('[AC-F1-06zi#7] 33 characters fail the display_name CHECK on INSERT and UPDATE', async () => {
  await ready();
  for (const value of ['a'.repeat(33), '中'.repeat(33), '𠀀'.repeat(33)]) {
    await rejectsName(value);
  }
});

it('[AC-F1-06zi#8] the migration explicitly names and validates its char_length CHECK', async () => {
  await ready();
  const checks = await displayNameChecks();
  const lengthChecks = checks.filter((c) =>
    /\bchar_length\s*\(\s*display_name\s*\)/i.test(c.definition),
  );
  expect(lengthChecks.length, 'length counts characters, not bytes').toBeGreaterThan(0);
  const source = migrationSource();
  const declared = [...source.matchAll(/\bCONSTRAINT\s+(\w+)\s+CHECK\b/gi)].map((m) => m[1]);
  for (const check of lengthChecks) {
    expect(check.validated, check.name).toBe(true);
    expect(declared, 'CHECK must be explicitly named in the column migration').toContain(
      check.name,
    );
  }
});

it('[AC-F1-06zi#9] grants extend the new column while preserving the existing table privilege model', async () => {
  await ready();
  const grants = await sql<{
    role: string;
    table_select: boolean;
    table_insert: boolean;
    table_update: boolean;
    column_select: boolean;
    column_update: boolean;
  }>`
    SELECT role,
           has_table_privilege(role, 'app.admin_users', 'SELECT') AS table_select,
           has_table_privilege(role, 'app.admin_users', 'INSERT') AS table_insert,
           has_table_privilege(role, 'app.admin_users', 'UPDATE') AS table_update,
           has_column_privilege(role, 'app.admin_users', 'display_name', 'SELECT') AS column_select,
           has_column_privilege(role, 'app.admin_users', 'display_name', 'UPDATE') AS column_update
    FROM (VALUES ('couli_app'), ('couli_readonly')) AS roles(role) ORDER BY role
  `.execute(app);
  expect(grants.rows).toEqual([
    {
      role: 'couli_app',
      table_select: true,
      table_insert: true,
      table_update: false,
      column_select: true,
      column_update: true,
    },
    {
      role: 'couli_readonly',
      table_select: false,
      table_insert: false,
      table_update: false,
      column_select: true,
      column_update: false,
    },
  ]);
  const source = migrationSource();
  for (const [privilege, role] of [
    ['UPDATE', 'couli_app'],
    ['SELECT', 'couli_readonly'],
  ]) {
    expect(source, `${role} column grant belongs to the adding migration`).toMatch(
      new RegExp(
        `\\bGRANT\\s+${privilege}\\s*\\(\\s*display_name\\s*\\)\\s+ON\\s+(?:TABLE\\s+)?app\\s*\\.\\s*admin_users\\s+TO\\s+${role}\\b`,
        'i',
      ),
    );
  }
});

it('[AC-F1-06zi#10] couli_readonly can SELECT both a stored display_name and NULL', async () => {
  await ready();
  for (const value of ['后台处理人', null]) {
    const row = await newAdmin(app, { display_name: value });
    expect(await stored(row['id'], readonly)).toBe(value);
  }
});

it('[AC-F1-06zi#11] couli_readonly cannot UPDATE display_name even without reading any columns', async () => {
  await ready();
  // No predicate reads or RETURNING: lack of SELECT must not conceal an UPDATE grant.
  await expect(
    sql`UPDATE app.admin_users SET display_name = '越权' WHERE false`.execute(readonly),
  ).rejects.toMatchObject({ code: '42501' });
});
