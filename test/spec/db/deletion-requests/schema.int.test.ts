// Storage contract: B1-15a §9.2–9.3, 04 §3.2, BR-ID-27/28, ADR-0001 §4.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { close, open, ready, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = open(await createTestDatabase());
});
afterAll(async () => {
  await close(h);
});

it('[AC-B1-15a#1] columns have the specified types, nullability and defaults', async () => {
  await ready(h.app);
  const result = await sql`
    SELECT column_name AS name, udt_name AS type, is_nullable = 'YES' AS nullable,
      column_default AS default, is_identity AS identity, is_generated AS generated
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'deletion_requests'
    ORDER BY column_name
  `.execute(h.app);
  const expected: [string, string, boolean, string | null][] = [
    ['app_id', 'text', false, null],
    ['apple_revoke_attempts', 'int2', false, '0'],
    ['apple_revoke_result', 'text', true, null],
    ['apply_at', 'timestamptz', false, null],
    ['balance_snapshot_fen', 'int8', false, null],
    ['cancel_reason', 'text', true, null],
    ['cancelled_at', 'timestamptz', true, null],
    ['cleaned_at', 'timestamptz', true, null],
    ['cooling_until', 'timestamptz', false, null],
    ['created_at', 'timestamptz', false, 'now()'],
    ['id', 'uuid', false, null],
    ['processed_at', 'timestamptz', true, null],
    ['row_version', 'int4', false, '0'],
    ['status', 'text', false, null],
    ['updated_at', 'timestamptz', false, 'now()'],
    ['user_id', 'uuid', false, null],
  ];
  expect(result.rows).toEqual(
    expected.map(([name, type, nullable, defaultValue]) => ({
      name,
      type,
      nullable,
      default: defaultValue,
      identity: 'NO',
      generated: 'NEVER',
    })),
  );
});

it('[AC-B1-15a#2] named primary key and tenant-qualified user foreign key are validated and cannot cascade', async () => {
  await ready(h.app);
  const result = await sql<{
    name: string;
    kind: string;
    keys: string[];
    target: string | null;
    target_keys: string[];
    on_update: string;
    on_delete: string;
    validated: boolean;
    deferrable: boolean;
  }>`
    SELECT c.conname AS name, c.contype::text AS kind,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, position)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
        ORDER BY k.position) AS keys,
      CASE WHEN c.confrelid = 0 THEN NULL ELSE c.confrelid::regclass::text END AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, position)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num
        ORDER BY k.position) AS target_keys,
      c.confupdtype::text AS on_update, c.confdeltype::text AS on_delete,
      c.convalidated AS validated, c.condeferrable AS deferrable
    FROM pg_constraint c WHERE c.conrelid = 'app.deletion_requests'::regclass
      AND c.contype IN ('p', 'f')
    ORDER BY c.conname
  `.execute(h.app);
  expect(result.rows).toHaveLength(2);
  expect(result.rows[0]).toMatchObject({
    name: 'deletion_requests_pkey',
    kind: 'p',
    keys: ['id'],
    target: null,
    validated: true,
    deferrable: false,
  });
  expect(result.rows[1]).toMatchObject({
    name: 'deletion_requests_user_fkey',
    kind: 'f',
    keys: ['app_id', 'user_id'],
    target: 'app.users',
    target_keys: ['app_id', 'id'],
    validated: true,
  });
  expect(['a', 'r']).toContain(result.rows[1]?.on_update);
  expect(['a', 'r']).toContain(result.rows[1]?.on_delete);
});

it('[AC-B1-15a#3] open-user, cross-app scheduler and latest-request indexes have the required keys', async () => {
  await ready(h.app);
  const result = await sql<{
    name: string;
    definition: string;
    keys: string[];
    unique: boolean;
    predicate: string | null;
    valid: boolean;
    ready: boolean;
  }>`
    SELECT p.indexname AS name, p.indexdef AS definition, i.indisunique AS unique,
      ARRAY(SELECT a.attname::text
        FROM unnest(i.indkey) WITH ORDINALITY k(num, position)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
        WHERE k.position <= i.indnkeyatts ORDER BY k.position) AS keys,
      pg_get_expr(i.indpred, i.indrelid) AS predicate,
      i.indisvalid AS valid, i.indisready AS ready
    FROM pg_indexes p JOIN pg_namespace n ON n.nspname = p.schemaname
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = p.indexname
      JOIN pg_index i ON i.indexrelid = c.oid
    WHERE p.schemaname = 'app' AND p.tablename = 'deletion_requests'
  `.execute(h.app);
  const openIndex = result.rows.find((r) => r.name === 'deletion_requests_open_user_key');
  // users.id is globally unique: a second app cannot contain the same user UUID.
  // Assert the tenant dimension directly without bypassing the users PK or the FK.
  expect(openIndex).toMatchObject({
    keys: ['app_id', 'user_id'],
    unique: true,
    valid: true,
    ready: true,
  });
  expect(openIndex?.definition).toMatch(/CREATE UNIQUE INDEX .* WHERE /);
  expect(openIndex?.predicate).toBe("(status = ANY (ARRAY['cooling'::text, 'processing'::text]))");
  for (const [name, keys] of [
    ['deletion_requests_status_cooling_until_idx', ['status', 'cooling_until']],
    ['deletion_requests_user_apply_idx', ['app_id', 'user_id', 'apply_at']],
  ] as const) {
    expect(result.rows.find((r) => r.name === name)).toMatchObject({
      keys,
      unique: false,
      predicate: null,
      valid: true,
      ready: true,
    });
  }
  expect(
    result.rows.find((r) => r.name === 'deletion_requests_user_apply_idx')?.definition,
  ).toMatch(/\(app_id, user_id, apply_at DESC\)/);
});
