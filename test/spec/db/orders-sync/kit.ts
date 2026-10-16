// B1-08c / D10-16: storage rules only; no pipeline, retention or platform fixtures.
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { columns, insertRow, newOrderKey, useDb } from '../orders/kit.ts';

export { columns, foreignKeys, sqlState } from '../orders/kit.ts';
export const TABLES = [
  'sync_cursors',
  'order_sync_pending',
  'order_sync_counters',
  'order_sync_drops',
  'order_sync_drop_keys',
  'order_status_history',
] as const;
export type Table = (typeof TABLES)[number];
export const APPEND_ONLY: readonly Table[] = ['order_sync_drop_keys', 'order_status_history'];
export const AT = new Date('2026-10-17T15:59:59.000Z');
export const LATER = new Date('2026-10-17T16:00:01.000Z');
export const DAY = '2026-10-17';
export const REASONS = [
  'UNMAPPED_STATUS',
  'UNFREEZE_SIGNAL',
  'ILLEGAL_TRANSITION',
  'NO_RECEIVED_AT',
  'CLAWBACK_NO_COMMISSION',
  'SERVICE_FEE_RATE_MISSING',
  'RULE_VERSION_PLATFORM_MISSING',
  'TLJ_FACE_VALUE_UNMATCHED',
  'AMOUNT_PARSE_FAILED',
] as const;
export const COUNTERS = ['attr_param_invalid', 'attr_binding_miss', 'order_sync_no_mtime'];

export function connect(db: Kysely<DB>): void {
  useDb(db);
}

// Must be called inside every test before DML: an absent migration is an assertion failure.
export async function requireTable(db: Kysely<DB>, table: Table): Promise<void> {
  const result = await sql<{ kind: string }>`
    SELECT relkind::text AS kind FROM pg_class WHERE oid = to_regclass(${`app.${table}`})
  `.execute(db);
  expect(result.rows, `app.${table} exists and is not partitioned`).toEqual([{ kind: 'r' }]);
}

export async function newAccount(appId = 'couli', platform = 'taobao'): Promise<unknown> {
  const id = randomUUID();
  await insertRow('union_accounts', {
    id,
    app_id: appId,
    platform,
    account_name: `synthetic-${id}`,
    status: 'active',
    auth_status: 'active',
  });
  return id;
}

export async function orderId(appId = 'couli'): Promise<unknown> {
  return (await newOrderKey({ app_id: appId })).orderId;
}

// All business fields are explicit. Only an optional surrogate id adapts to UUID / identity.
// The older catalog filler is used solely to satisfy dependency tables' existing schemas.
export async function fixture(table: Table, values: Record<string, unknown> = {}) {
  const appId = String(values['app_id'] ?? 'couli');
  const platform = String(values['platform'] ?? 'taobao');
  let row: Record<string, unknown> = { app_id: appId, platform };
  switch (table) {
    case 'sync_cursors':
      row = {
        ...row,
        union_account_id: values['union_account_id'] ?? (await newAccount(appId, platform)),
        query_kind: 'updated_at',
        scene: '-',
        cursor_at: AT,
        updated_at: AT,
      };
      break;
    case 'order_sync_pending':
      row = {
        ...row,
        sub_order_id: randomUUID(),
        order_id: null,
        reason: 'UNMAPPED_STATUS',
        raw_status: null,
        raw_payload_id: null,
        detail: 'synthetic unmapped status',
        detected_at: AT,
        status: 'open',
        resolved_by: null,
        resolved_at: null,
        resolution_note: null,
      };
      break;
    case 'order_sync_counters':
      row = { ...row, date: DAY, counter: 'attr_param_invalid', count: 0n };
      break;
    case 'order_sync_drops':
      row = { ...row, date: DAY, reason: 'NO_PAY_TIME', count: 0n };
      break;
    case 'order_sync_drop_keys':
      row = { ...row, sub_order_id: randomUUID(), reason: 'NO_PAY_TIME' };
      break;
    case 'order_status_history':
      row = {
        app_id: appId,
        order_id: values['order_id'] ?? (await orderId(appId)),
        field: 'platform',
        from_status: null,
        event: 'P1',
        to_status: 'PAID',
        source: 'sync',
        at: AT,
      };
      break;
  }
  const id = (await columns(table)).find((column) => column.name === 'id');
  if (id?.type === 'uuid') row['id'] = randomUUID();
  return { ...row, ...values };
}

export async function insert(db: Kysely<DB>, table: Table, row: Record<string, unknown>) {
  return sql<Record<string, unknown>>`
    INSERT INTO ${sql.table(`app.${table}`)}
      (${sql.join(Object.keys(row).map((name) => sql.ref(name)))})
    VALUES (${sql.join(Object.values(row))}) RETURNING *
  `.execute(db);
}

// A duplicate business key must not fail just because the surrogate id was copied.
export async function repeat(
  db: Kysely<DB>,
  table: Table,
  row: Record<string, unknown>,
  changes: Record<string, unknown> = {},
) {
  const next = { ...row, ...changes };
  delete next['id'];
  if ((await columns(table)).find((column) => column.name === 'id')?.type === 'uuid') {
    next['id'] = randomUUID();
  }
  return insert(db, table, next);
}

export async function constraints(db: Kysely<DB>, table: Table) {
  return (
    await sql<{ name: string; kind: string; cols: string[]; def: string }>`
    SELECT c.conname::text AS name, c.contype::text AS kind,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
        ORDER BY k.ord) AS cols, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c WHERE c.conrelid = to_regclass(${`app.${table}`})
  `.execute(db)
  ).rows;
}

export async function expectUnique(db: Kysely<DB>, table: Table, cols: string[]) {
  const keys = (await constraints(db, table)).filter((c) => c.kind === 'u');
  expect(keys).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: expect.any(String), cols })]),
  );
  expect(keys.every((key) => key.name.length > 0)).toBe(true);
}

export async function expectCheck(
  db: Kysely<DB>,
  table: Table,
  column: string,
  values: readonly string[],
) {
  const checks = (await constraints(db, table)).filter(
    (c) => c.kind === 'c' && c.cols.includes(column),
  );
  expect(checks.length, `${table}.${column} has a named CHECK`).toBeGreaterThan(0);
  const literals = checks.flatMap((c) => [...c.def.matchAll(/'([^']*)'/g)].map((m) => m[1]));
  expect([...new Set(literals)].sort()).toEqual([...values].sort());
}
