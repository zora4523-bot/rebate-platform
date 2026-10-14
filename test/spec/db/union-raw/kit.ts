// B1-04a: storage only. Synthetic bytes, not a platform response or recording.
// request_summary/jsonb, latency_ms/integer and nullable error_code/text are technical
// column choices for 02 §6.1; latency_ms follows the existing schema convention.
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TABLE = 'union_raw_payloads';
export const TIMEOUT = 60_000;
export const PAYLOAD = gzipSync(Buffer.from('{"synthetic":true,"fixture":"B1-04a"}'));
export const HASH = createHash('sha256').update(PAYLOAD).digest('hex');
export const SUMMARY = { source: 'synthetic', operation: 'archive-test' };
export const REQUIRED = [
  'id',
  'app_id',
  'platform',
  'kind',
  'payload',
  'fetched_at',
  'content_hash',
  'request_summary',
  'latency_ms',
];

export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default_expr: string | null;
}

export async function columns(db: Kysely<DB>): Promise<Column[]> {
  const result = await sql<Column>`
    SELECT a.attname::text AS name, t.typname::text AS type,
      NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS default_expr
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = to_regclass('app.union_raw_payloads')
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `.execute(db);
  return result.rows;
}

// Every scenario first fails on an assertion on main, never on undefined_table.
export async function requireTable(db: Kysely<DB>): Promise<void> {
  const result = await sql<{ name: string | null }>`
    SELECT to_regclass('app.union_raw_payloads')::text AS name
  `.execute(db);
  expect(result.rows[0]?.name, 'B1-04a must create app.union_raw_payloads').toBe(
    'app.union_raw_payloads',
  );
}

export async function requireColumns(db: Kysely<DB>): Promise<void> {
  await requireTable(db);
  expect((await columns(db)).map(({ name }) => name)).toEqual(
    expect.arrayContaining([...REQUIRED, 'error_code']),
  );
}

export function fixture(fetchedAt = '2032-06-15T12:00:00Z'): Record<string, unknown> {
  return {
    app_id: 'couli',
    platform: 'taobao',
    kind: 'query',
    payload: PAYLOAD,
    fetched_at: new Date(fetchedAt),
    content_hash: HASH,
    request_summary: JSON.stringify(SUMMARY),
    latency_ms: 37,
    error_code: null,
  };
}

export async function insert(db: Kysely<DB>, row: Record<string, unknown>): Promise<void> {
  await sql`INSERT INTO app.union_raw_payloads
    (${sql.join(Object.keys(row).map((name) => sql.ref(name)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}

export async function stored(db: Kysely<DB>, fetchedAt: string) {
  return (
    await sql<{
      id: bigint;
      app_id: string;
      platform: string;
      kind: string;
      payload: Buffer;
      fetched_at: Date;
      content_hash: string;
      request_summary: typeof SUMMARY;
      latency_ms: number;
      error_code: string | null;
      part: string;
    }>`SELECT id, app_id, platform, kind, payload, fetched_at, content_hash,
      request_summary, latency_ms, error_code, tableoid::regclass::text AS part
      FROM app.union_raw_payloads WHERE fetched_at = ${fetchedAt}::timestamptz
      ORDER BY id`.execute(db)
  ).rows;
}
