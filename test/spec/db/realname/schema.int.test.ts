// Exact storage contract from B1-13b §9.3 (04 §3.2, ADR-0001 §4).
import { existsSync, readFileSync } from 'node:fs';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { close, columns, open, ready, type Harness, type Table } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = open(await createTestDatabase());
});
afterAll(async () => {
  await close(h);
});

const migration = new URL(
  '../../../../db/migrations/0041_realname-deleted-identities.sql',
  import.meta.url,
);

it('[AC-B1-13b#1] realname has exactly the specified types, nullability and defaults', async () => {
  await ready(h.app, 'realname');
  const expected = [
    ['app_id', 'text', false, null],
    ['birth_date_cipher', 'bytea', true, null],
    ['created_at', 'timestamptz', false, 'now()'],
    ['id', 'uuid', false, null],
    ['id_no_cipher', 'bytea', true, null],
    ['id_no_hmac', 'text', true, null],
    ['name_cipher', 'bytea', true, null],
    ['provider', 'text', true, null],
    ['row_version', 'int4', false, '0'],
    ['status', 'text', false, null],
    ['updated_at', 'timestamptz', false, 'now()'],
    ['user_id', 'uuid', false, null],
    ['verified_at', 'timestamptz', true, null],
  ].map(([name, type, nullable, defaultValue]) => ({
    name,
    type,
    nullable,
    default: defaultValue,
    identity: null,
  }));
  // Exact set also excludes adult_at, birth_year and plaintext personal information.
  expect(await columns(h.app, 'realname')).toEqual(expected);
});

it('[AC-B1-13b#2] deleted_identities uses an ALWAYS identity and application-supplied deletion/expiry times', async () => {
  await ready(h.app, 'deleted_identities');
  expect(await columns(h.app, 'deleted_identities')).toEqual([
    { name: 'app_id', type: 'text', nullable: false, default: null, identity: null },
    { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()', identity: null },
    { name: 'deleted_at', type: 'timestamptz', nullable: false, default: null, identity: null },
    { name: 'device_hash', type: 'text', nullable: true, default: null, identity: null },
    { name: 'expire_at', type: 'timestamptz', nullable: false, default: null, identity: null },
    { name: 'id', type: 'int8', nullable: false, default: null, identity: 'ALWAYS' },
    { name: 'phone_hmac', type: 'text', nullable: true, default: null, identity: null },
    { name: 'reason', type: 'text', nullable: false, default: null, identity: null },
  ]);
  // Exact set excludes user_id, id_no_hmac and negative_fen.
});

async function constraints(table: Table) {
  return (
    await sql<{
      name: string;
      kind: string;
      keys: string[];
      target: string | null;
      target_keys: string[];
      on_update: string;
      on_delete: string;
      validated: boolean;
    }>`SELECT c.conname AS name, c.contype::text AS kind,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, position)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
        ORDER BY k.position) AS keys,
      CASE WHEN c.confrelid = 0 THEN NULL ELSE c.confrelid::regclass::text END AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, position)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num
        ORDER BY k.position) AS target_keys,
      c.confupdtype::text AS on_update, c.confdeltype::text AS on_delete,
      c.convalidated AS validated
    FROM pg_constraint c WHERE c.conrelid = to_regclass(${`app.${table}`})
      AND c.contype IN ('p', 'u', 'f', 'c') ORDER BY c.conname`.execute(h.app)
  ).rows;
}

it('[AC-B1-13b#3] named keys and tenant-qualified user FK exist and cannot cascade', async () => {
  await ready(h.app, 'realname');
  await ready(h.app, 'deleted_identities');
  const real = await constraints('realname');
  const deleted = await constraints('deleted_identities');
  const keyShapes = real.filter((c) => c.kind !== 'c').map((c) => ({ kind: c.kind, keys: c.keys }));
  expect(keyShapes).toHaveLength(4);
  expect(keyShapes).toEqual(
    expect.arrayContaining([
      { kind: 'p', keys: ['id'] },
      { kind: 'u', keys: ['app_id', 'id'] },
      { kind: 'u', keys: ['app_id', 'user_id'] },
      { kind: 'f', keys: ['app_id', 'user_id'] },
    ]),
  );
  const foreign = real.filter((c) => c.kind === 'f');
  expect(foreign).toHaveLength(1);
  expect(foreign[0]).toMatchObject({ target: 'app.users', target_keys: ['app_id', 'id'] });
  expect(['a', 'r']).toContain(foreign[0]?.on_update);
  expect(['a', 'r']).toContain(foreign[0]?.on_delete);
  expect(
    deleted.filter((c) => c.kind !== 'c').map((c) => ({ kind: c.kind, keys: c.keys })),
  ).toEqual([{ kind: 'p', keys: ['id'] }]);
  for (const list of [real, deleted]) {
    expect(list.some((c) => c.kind === 'c')).toBe(true);
    for (const constraint of list) expect(constraint.validated, constraint.name).toBe(true);
  }
  expect(existsSync(migration)).toBe(true);
  const source = readFileSync(migration, 'utf8').replace(/--[^\n]*/g, '');
  for (const [table, list] of [
    ['realname', real],
    ['deleted_identities', deleted],
  ] as const) {
    for (const constraint of list) {
      // Names are implementation choices; the migration must explicitly name each constraint.
      expect(constraint.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(source).toMatch(new RegExp(`\\bCONSTRAINT\\s+"?${constraint.name}"?\\s`, 'i'));
      const lookup = await sql<{ name: string }>`SELECT conname AS name FROM pg_constraint
        WHERE conrelid = to_regclass(${`app.${table}`}) AND conname = ${constraint.name}`.execute(
        h.app,
      );
      expect(lookup.rows).toEqual([{ name: constraint.name }]);
    }
  }
});

async function indexes(table: Table) {
  return (
    await sql<{
      name: string;
      unique: boolean;
      keys: string[];
      predicate: string | null;
      valid: boolean;
      ready: boolean;
    }>`SELECT ic.relname AS name, i.indisunique AS unique, i.indisvalid AS valid,
      i.indisready AS ready,
      ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true)
        FROM generate_series(1, i.indnkeyatts) k ORDER BY k) AS keys,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = to_regclass(${`app.${table}`}) ORDER BY ic.relname`.execute(h.app)
  ).rows;
}

function predicate(value: string | null): string | null {
  return (
    value
      ?.replace(/[()]/g, '')
      .replace(/::text/g, '')
      .replace(/\s+/g, ' ')
      .trim() ?? null
  );
}

it('[AC-B1-13b#4] named indexes enforce verified-only uniqueness and cover tombstone lookups/expiry', async () => {
  await ready(h.app, 'realname');
  await ready(h.app, 'deleted_identities');
  const real = await indexes('realname');
  const deleted = await indexes('deleted_identities');
  const shape = (index: (typeof real)[number]) => ({
    name: index.name,
    unique: index.unique,
    keys: index.keys,
    predicate: predicate(index.predicate),
  });
  expect(real.map(shape)).toEqual(
    expect.arrayContaining([
      {
        name: 'realname_verified_id_no_hmac_key',
        unique: true,
        keys: ['app_id', 'id_no_hmac'],
        predicate: "status = 'verified'",
      },
    ]),
  );
  expect(deleted.map(shape)).toEqual(
    expect.arrayContaining([
      {
        name: 'deleted_identities_phone_hmac_idx',
        unique: false,
        keys: ['app_id', 'phone_hmac'],
        predicate: 'phone_hmac IS NOT NULL',
      },
      {
        name: 'deleted_identities_device_hash_idx',
        unique: false,
        keys: ['app_id', 'device_hash'],
        predicate: 'device_hash IS NOT NULL',
      },
      {
        name: 'deleted_identities_expire_at_idx',
        unique: false,
        keys: ['expire_at'],
        predicate: null,
      },
    ]),
  );
  expect(deleted.filter((index) => index.unique).map((index) => index.keys)).toEqual([['id']]);
  for (const index of [...real, ...deleted]) {
    expect(index.valid && index.ready, index.name).toBe(true);
  }
  // Fixed names are the migration contract, never expectations derived from the catalog.
  for (const [table, names] of [
    ['realname', ['realname_verified_id_no_hmac_key']],
    [
      'deleted_identities',
      [
        'deleted_identities_phone_hmac_idx',
        'deleted_identities_device_hash_idx',
        'deleted_identities_expire_at_idx',
      ],
    ],
  ] as const) {
    for (const name of names) {
      const lookup = await sql<{ name: string }>`SELECT indexname AS name FROM pg_indexes
        WHERE schemaname = 'app' AND tablename = ${table} AND indexname = ${name}`.execute(h.app);
      expect(lookup.rows).toEqual([{ name }]);
    }
  }
});

it('[AC-B1-13b#23] migration 0041 declares timeouts and grants alongside both new tables', async () => {
  expect(existsSync(migration), '0041 migration must exist').toBe(true);
  const source = readFileSync(migration, 'utf8');
  expect(source.split('\n')[0]).toBe('-- Up Migration');
  expect(source).toContain('B1-13b');
  expect(source).not.toMatch(/--\s*Down Migration/i);
  const sqlText = source.replace(/--[^\n]*/g, '');
  expect(sqlText.trimStart()).toMatch(
    /^SET\s+LOCAL\s+lock_timeout\s*=\s*'5s'\s*;\s*SET\s+LOCAL\s+statement_timeout\s*=\s*'30s'\s*;/i,
  );
  expect(sqlText).not.toMatch(/\bDO\s+(?:\$|')/i);
  for (const table of ['realname', 'deleted_identities']) {
    expect(sqlText).toMatch(new RegExp(`CREATE\\s+TABLE\\s+app\\.${table}\\s*\\(`, 'i'));
    for (const role of ['couli_app', 'couli_readonly']) {
      expect(sqlText).toMatch(
        new RegExp(
          `GRANT\\s+[^;]+\\bON\\s+(?:TABLE\\s+)?[^;]*\\bapp\\.${table}\\b[^;]*\\bTO\\s+${role}\\b`,
          'i',
        ),
      );
    }
  }
});
