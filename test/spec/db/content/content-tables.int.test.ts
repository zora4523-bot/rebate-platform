// Rule tests for the content and configuration tables of F1-02a (规划/04 §3.2 rows
// `articles / agreements / dict_items / app_versions` and `config_items / kill_switches`, §6.2
// NoticeItem, §10; TECH-19 via the 04 §3.2 row; ADR-0001 §4 and db/AGENTS.md for app_id,
// row_version and grants). Real PostgreSQL as couli_app (the content module and the admin process
// write these tables). Columns whose names 04 leaves to the implementation (category, title, body,
// status of articles) are filled from the catalog by kit.ts. Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  CHECK_VIOLATION,
  UNIQUE_VIOLATION,
  column,
  columns,
  insertRow,
  sqlState,
  unique,
  useDb,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  useDb(app);
});

afterAll(async () => {
  await destroyDb(app);
  await database.drop();
});

const TABLES = ['app_versions', 'articles', 'config_items'] as const;

async function newAppVersion(values: Record<string, unknown> = {}): Promise<void> {
  await insertRow('app_versions', {
    app_id: 'couli',
    platform: 'android',
    channel: unique('ch'),
    ...values,
  });
}

// ---------------------------------------------------------------------------------------------
// app_versions (04 §3.2; TECH-19; 2026-10-03 功能对照 G-85, default_store and store_listings)
// ---------------------------------------------------------------------------------------------

it('[AC-F1-02a#1] app_versions carries the version-check columns of 04 §3.2', async () => {
  const names = (await columns('app_versions')).map((c) => c.name);
  for (const name of [
    'app_id',
    'platform',
    'channel',
    'latest_version',
    'min_supported_version',
    'recommended_version',
    'update_title',
    'update_notes',
    'store_url',
    'default_store',
    'store_listings',
    'row_version',
  ]) {
    expect(names, name).toContain(name);
  }
  expect((await column('app_versions', 'default_store'))?.type).toBe('text');
  expect((await column('app_versions', 'store_listings'))?.type).toBe('jsonb');
});

it('[AC-F1-02a#2] app_versions has no force flag and no download address of any kind (TECH-19)', async () => {
  const names = (await columns('app_versions')).map((c) => c.name);
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    expect(name, name).not.toMatch(/force|download|apk|package|install/);
  }
});

it('[AC-F1-02a#3] app_versions is unique by (app_id, platform, channel)', async () => {
  const channel = unique('ch');
  await newAppVersion({ platform: 'android', channel });
  expect(await sqlState(newAppVersion({ platform: 'android', channel }))).toBe(UNIQUE_VIOLATION);
  expect(await sqlState(newAppVersion({ platform: 'harmony', channel }))).toBe('no error');
  expect(await sqlState(newAppVersion({ platform: 'android', channel: unique('ch') }))).toBe(
    'no error',
  );
  expect(await sqlState(newAppVersion({ app_id: 'couli_two', platform: 'android', channel }))).toBe(
    'no error',
  );
});

it('[AC-F1-02a#4] store_listings only holds a JSON array, and keeps the order it was written in', async () => {
  for (const bad of ['{}', '{"huawei": "1.2.0"}', '"huawei"', '1']) {
    expect(await sqlState(newAppVersion({ store_listings: bad })), bad).toBe(CHECK_VIOLATION);
  }
  const listings = [
    { store: 'xiaomi', listed_version: '1.3.0' },
    { store: 'huawei', listed_version: null },
    { store: 'oppo', listed_version: '1.2.9' },
  ];
  const channel = unique('ch');
  await newAppVersion({ channel, store_listings: JSON.stringify(listings) });
  const stored = await sql<{ listings: unknown }>`
    SELECT store_listings AS listings FROM app.app_versions
    WHERE app_id = 'couli' AND platform = 'android' AND channel = ${channel}
  `.execute(app);
  expect(stored.rows).toEqual([{ listings }]);
  expect(await sqlState(newAppVersion({ store_listings: '[]' }))).toBe('no error');
});

// ---------------------------------------------------------------------------------------------
// articles (04 §3.2 notice columns; §6.2 NoticeItem content_version ≥ 1)
// ---------------------------------------------------------------------------------------------

it('[AC-F1-02a#5] articles carries the three notice columns with their types', async () => {
  expect((await column('articles', 'notice_closable'))?.type).toBe('bool');
  expect((await column('articles', 'notice_content_version'))?.type).toBe('int4');
  const endAt = await column('articles', 'notice_end_at');
  expect(endAt?.type).toBe('timestamptz');
  // Closable notices may run without an end; the "required when not closable" rule is checked by
  // the application on save (04 §3.2 row, brief §2), not by the table.
  expect(endAt?.nullable).toBe(true);
  expect(
    await sqlState(
      insertRow('articles', {
        app_id: 'couli',
        notice_closable: true,
        notice_content_version: 1,
        notice_end_at: null,
      }),
    ),
  ).toBe('no error');
});

it('[AC-F1-02a#6] notice_content_version is at least 1 (04 §6.2 NoticeItem)', async () => {
  for (const bad of [0, -1]) {
    expect(
      await sqlState(insertRow('articles', { app_id: 'couli', notice_content_version: bad })),
      String(bad),
    ).toBe(CHECK_VIOLATION);
  }
  expect(
    await sqlState(insertRow('articles', { app_id: 'couli', notice_content_version: 1 })),
  ).toBe('no error');
  expect(
    await sqlState(insertRow('articles', { app_id: 'couli', notice_content_version: 7 })),
  ).toBe('no error');
});

// ---------------------------------------------------------------------------------------------
// config_items (04 §3.2 key, value JSON, version, updated_by; §10)
// ---------------------------------------------------------------------------------------------

it('[AC-F1-02a#7] config_items has key, a jsonb value, an integer version and updated_by', async () => {
  const key = await column('config_items', 'key');
  expect(key?.type).toBe('text');
  expect(key?.nullable).toBe(false);
  const value = await column('config_items', 'value');
  expect(value?.type).toBe('jsonb');
  expect(value?.nullable).toBe(false);
  const version = await column('config_items', 'version');
  expect(['int4', 'int8']).toContain(version?.type);
  expect(version?.nullable).toBe(false);
  expect(await column('config_items', 'updated_by')).toBeDefined();
});

it('[AC-F1-02a#8] a config key appears once per app', async () => {
  const key = unique('test.key.');
  await insertRow('config_items', { app_id: 'couli', key, value: 'true' });
  expect(await sqlState(insertRow('config_items', { app_id: 'couli', key, value: 'false' }))).toBe(
    UNIQUE_VIOLATION,
  );
  expect(
    await sqlState(insertRow('config_items', { app_id: 'couli_two', key, value: 'false' })),
  ).toBe('no error');
});

it('[AC-F1-02a#9] a config value holds any JSON: boolean, number, string, array, object', async () => {
  for (const value of ['true', '1800', '"web_code"', '["web_code"]', '[]', '{"a": 1}']) {
    const key = unique('test.json.');
    expect(await sqlState(insertRow('config_items', { app_id: 'couli', key, value })), value).toBe(
      'no error',
    );
    const stored = await sql<{ same: boolean }>`
      SELECT value = ${value}::jsonb AS same FROM app.config_items
      WHERE app_id = 'couli' AND key = ${key}
    `.execute(app);
    expect(stored.rows, value).toEqual([{ same: true }]);
  }
});

// ---------------------------------------------------------------------------------------------
// Common columns and grants (db/AGENTS.md rules 4 and 7; ADR-0001 §4.1 CAS)
// ---------------------------------------------------------------------------------------------

it('[AC-F1-02a#10] every table carries app_id NOT NULL and row_version integer NOT NULL DEFAULT 0', async () => {
  for (const table of TABLES) {
    const appId = await column(table, 'app_id');
    expect(appId?.type, table).toBe('text');
    expect(appId?.nullable, table).toBe(false);
    const rowVersion = await column(table, 'row_version');
    expect(rowVersion?.type, table).toBe('int4');
    expect(rowVersion?.nullable, table).toBe(false);
    expect(rowVersion?.default, table).toBe('0');
  }
  expect(await sqlState(insertRow('config_items', { app_id: null, key: unique('k.') }))).not.toBe(
    'no error',
  );
});

it('[AC-F1-02a#11] couli_app reads, inserts and updates the three tables, nothing more', async () => {
  for (const table of TABLES) {
    const rows = await sql<{ privilege: string; held: boolean }>`
      SELECT p AS privilege, has_table_privilege('couli_app', ${`app.${table}`}, p) AS held
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
    `.execute(app);
    expect(Object.fromEntries(rows.rows.map((r) => [r.privilege, r.held])), table).toEqual({
      SELECT: true,
      INSERT: true,
      UPDATE: true,
      TRUNCATE: false,
      REFERENCES: false,
      TRIGGER: false,
    });
  }
});

it('[AC-F1-02a#12] other roles: readonly only reads, payout and maint never write, PUBLIC gets nothing', async () => {
  for (const table of TABLES) {
    const rows = await sql<{ role: string; privilege: string; held: boolean }>`
      SELECT r AS role, p AS privilege,
             has_table_privilege(r, ${`app.${table}`}, p) AS held
      FROM unnest(ARRAY['couli_readonly', 'couli_payout', 'couli_maint']) AS r
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
    `.execute(app);
    const held = new Set(rows.rows.filter((r) => r.held).map((r) => `${r.role}:${r.privilege}`));
    expect(held.has('couli_readonly:SELECT'), table).toBe(true);
    // couli_payout may read config_items (payout.* keys); it never writes any of these tables.
    for (const entry of held) {
      expect(['couli_readonly:SELECT', 'couli_payout:SELECT'], `${table} ${entry}`).toContain(
        entry,
      );
    }
    const acl = await sql<{ public_grants: string }>`
      SELECT count(*)::text AS public_grants
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
      WHERE n.nspname = 'app' AND c.relname = ${table} AND a.grantee = 0
    `.execute(app);
    expect(acl.rows, table).toEqual([{ public_grants: '0' }]);
  }
});
