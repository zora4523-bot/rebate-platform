// B1-09e: storage rules of the second order-table migration (04 §3.2 order_sync_requests,
// rights_imports / rights_import_failures; J-8 order_assignments; D10-169 K-2 order_rights key).
// Enum values are contracts/enums/order.yaml (CT-24n). The new tables are not in db.gen.ts when
// these tests are written, so every statement is raw SQL; tests assert object shapes and
// behaviour, never migration file names or constraint / index names.
import { createHash, randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import {
  checkedLiterals,
  columns,
  foreignKeys,
  newOrderKey,
  unique,
  useDb,
} from '../orders/kit.ts';

export { columns, foreignKeys, newOrderKey, sqlState, unique } from '../orders/kit.ts';

export const NEW_TABLES = [
  'order_sync_requests',
  'rights_imports',
  'rights_import_failures',
  'order_assignments',
] as const;
export type NewTable = (typeof NEW_TABLES)[number];
/** Tables the orders module only inserts into (task line: 只插入). */
export const APPEND_ONLY: readonly NewTable[] = ['rights_import_failures', 'order_assignments'];
/** Columns a worker must be able to move forward on the mutable tables (status and tallies). */
export const PROGRESS_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  order_sync_requests: ['status', 'fetched_count', 'stored_count', 'error', 'finished_at'],
  rights_imports: [
    'status',
    'total_rows',
    'succeeded_rows',
    'failed_rows',
    'skipped_rows',
    'duplicate_rows',
    'finished_at',
  ],
};
export const ROLES = ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint'] as const;

// contracts/enums/order.yaml (CT-24n).
export const ORDER_SYNC_MODE = ['window', 'order_nos'] as const;
export const ORDER_SYNC_STATUS = ['queued', 'running', 'done', 'failed'] as const;
export const RIGHTS_IMPORT_KIND = ['rights', 'punish', 'channel'] as const;
export const RIGHTS_IMPORT_TIME_BASIS = ['paid', 'received'] as const;
export const RIGHTS_IMPORT_STATUS = ['queued', 'running', 'done', 'failed'] as const;
export const RIGHTS_IMPORT_FAILURE_REASON = [
  'invalid_row',
  'order_not_found',
  'sub_order_no_missing',
  'received_at_missing',
  'platform_mismatch',
] as const;
/** J-8: order_assignments.source. */
export const ASSIGNMENT_SOURCE = ['claim', 'admin'] as const;

export const FROM = new Date('2026-10-21T16:00:00.000Z');
export const TO = new Date('2026-10-22T16:00:00.000Z');
export const FINISHED = new Date('2026-10-22T16:05:00.000Z');

/** A fresh filter digest shaped like a sha256 hex (64 lowercase hex characters). */
export function digest(): string {
  return createHash('sha256').update(randomUUID()).digest('hex');
}

/** Ended fixtures (done / failed) carry finished_at; queued / running ones leave it empty. */
function finishedFor(values: Record<string, unknown>): Record<string, unknown> {
  const status = values['status'];
  return status === 'done' || status === 'failed' ? { finished_at: FINISHED } : {};
}

let app: Kysely<DB>;

/** Fixtures are inserted as this (application-role) connection. */
export function connect(db: Kysely<DB>): void {
  app = db;
  useDb(db);
}

// Must be called inside every test before DML: an absent migration is an assertion failure.
export async function requireTable(db: Kysely<DB>, table: string): Promise<void> {
  const result = await sql<{ kind: string }>`
    SELECT relkind::text AS kind FROM pg_class WHERE oid = to_regclass(${`app.${table}`})
  `.execute(db);
  expect(result.rows, `app.${table} exists and is not partitioned`).toEqual([{ kind: 'r' }]);
}

export type IndexInfo = {
  name: string;
  keys: string[];
  unique: boolean;
  primary: boolean;
  nullsNotDistinct: boolean;
  predicate: string | null;
  expressions: boolean;
  valid: boolean;
};

export async function indexes(db: Kysely<DB>, table: string): Promise<IndexInfo[]> {
  const result = await sql<{
    name: string;
    keys: string[];
    unique: boolean;
    primary: boolean;
    nulls_not_distinct: boolean;
    predicate: string | null;
    expressions: boolean;
    valid: boolean;
  }>`
    SELECT c.relname::text AS name,
      ARRAY(SELECT a.attname::text
        FROM unnest(i.indkey) WITH ORDINALITY k(num, position)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
        WHERE k.position <= i.indnkeyatts ORDER BY k.position) AS keys,
      i.indisunique AS unique, i.indisprimary AS primary,
      i.indnullsnotdistinct AS nulls_not_distinct,
      pg_get_expr(i.indpred, i.indrelid) AS predicate,
      i.indexprs IS NOT NULL AS expressions, i.indisvalid AS valid
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = to_regclass(${`app.${table}`})
  `.execute(db);
  return result.rows.map((r) => ({
    name: r.name,
    keys: r.keys,
    unique: r.unique,
    primary: r.primary,
    nullsNotDistinct: r.nulls_not_distinct,
    predicate: r.predicate,
    expressions: r.expressions,
    valid: r.valid,
  }));
}

/** Unique, valid, non-expression indexes whose key columns are exactly `keys` in any order. */
export async function uniqueIndexesOn(
  db: Kysely<DB>,
  table: string,
  keys: readonly string[],
): Promise<IndexInfo[]> {
  const wanted = [...keys].sort();
  return (await indexes(db, table)).filter(
    (i) =>
      i.unique &&
      i.valid &&
      !i.expressions &&
      i.keys.length === wanted.length &&
      [...i.keys].sort().every((k, at) => k === wanted[at]),
  );
}

/** Asserts a foreign key from `column` to `target` that neither cascades nor nulls on change. */
export async function expectForeignKey(table: string, column: string, target: string) {
  const fks = (await foreignKeys(table)).filter(
    (fk) => fk.target === target && fk.columns.includes(column),
  );
  expect(fks.length, `${table}.${column} references ${target}`).toBeGreaterThan(0);
  for (const fk of fks) {
    // a = NO ACTION, r = RESTRICT (db/AGENTS.md 迁移规则 7: 禁止级联).
    expect(['a', 'r'], `${fk.name} ON DELETE`).toContain(fk.onDelete);
    expect(['a', 'r'], `${fk.name} ON UPDATE`).toContain(fk.onUpdate);
  }
}

/** Every listed value appears in a CHECK constraint that mentions the column. */
export async function expectCheckLists(table: string, column: string, values: readonly string[]) {
  expect(await checkedLiterals(table, column), `${table}.${column} CHECK`).toEqual(
    expect.arrayContaining([...values]),
  );
}

/**
 * Filler for a NOT NULL column without default. Unlike the B1-08a kit, a referenced row is
 * created in the app of the row being built, so composite (app_id, …) keys stay consistent.
 */
async function filler(table: string, name: string, type: string, appId: string): Promise<unknown> {
  for (const fk of await foreignKeys(table)) {
    const at = fk.columns.indexOf(name);
    const target = fk.targetColumns[at];
    if (at >= 0 && name !== 'app_id' && target !== undefined) {
      const tenant = (await columns(fk.target)).some((c) => c.name === 'app_id');
      const row = await insertRow(fk.target, tenant ? { app_id: appId } : {});
      return row[target];
    }
  }
  const literal = (await checkedLiterals(table, name))[0];
  if (literal !== undefined) return literal;
  switch (type) {
    case 'uuid':
      return randomUUID();
    case 'int2':
    case 'int4':
    case 'int8':
    case 'numeric':
      return 0;
    case 'bool':
      return false;
    case 'timestamptz':
    case 'timestamp':
      return FROM;
    case 'date':
      return '2026-10-22';
    case 'jsonb':
    case 'json':
      return '{}';
    case 'bytea':
      return Buffer.from(unique('b'));
    default:
      return unique('v');
  }
}

/** Builds a row: the given values, app_id 'couli' when absent, a filler for other required columns. */
export async function buildRow(
  table: string,
  values: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = { ...values };
  const cols = await columns(table);
  if (!('app_id' in row) && cols.some((c) => c.name === 'app_id')) row['app_id'] = 'couli';
  const appId = String(row['app_id'] ?? 'couli');
  for (const col of cols) {
    if (col.name in row || col.nullable || col.hasDefault) continue;
    row[col.name] = await filler(table, col.name, col.type, appId);
  }
  return row;
}

export async function insert(db: Kysely<DB>, table: string, row: Record<string, unknown>) {
  const names = Object.keys(row);
  return sql<Record<string, unknown>>`
    INSERT INTO ${sql.table(`app.${table}`)} (${sql.join(names.map((n) => sql.ref(n)))})
    VALUES (${sql.join(names.map((n) => row[n]))}) RETURNING *
  `.execute(db);
}

/** Builds and inserts a row as the application role; resolves to the inserted row. */
export async function insertRow(
  table: string,
  values: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const row = await buildRow(table, values);
  const result = await insert(app, table, row);
  return result.rows[0] ?? row;
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

export async function newOrderId(appId = 'couli'): Promise<unknown> {
  return (await newOrderKey({ app_id: appId })).orderId;
}

/** A window-mode sync request; 04 §3.2 names the window columns `from` and `to`. */
export function syncRequest(values: Record<string, unknown> = {}) {
  return buildRow('order_sync_requests', {
    platform: 'taobao',
    mode: 'window',
    from: FROM,
    to: TO,
    status_filter: null,
    order_nos: null,
    status: 'queued',
    filter_digest: digest(),
    ...finishedFor(values),
    ...values,
  });
}

/** A rights import with a paid-time window (time_basis, from, to). */
export function rightsImport(values: Record<string, unknown> = {}) {
  return buildRow('rights_imports', {
    kind: 'rights',
    platform: 'taobao',
    union_account_id: null,
    time_basis: 'paid',
    from: FROM,
    to: TO,
    file_path: `rights-imports/${randomUUID()}.xlsx`,
    status: 'queued',
    ...finishedFor(values),
    ...values,
  });
}

/** A channel import: union account required, time_basis / from / to empty. */
export async function channelImport(values: Record<string, unknown> = {}) {
  const appId = String(values['app_id'] ?? 'couli');
  return rightsImport({
    kind: 'channel',
    union_account_id: await newAccount(appId),
    time_basis: null,
    from: null,
    to: null,
    ...values,
  });
}

export function importFailure(importId: unknown, values: Record<string, unknown> = {}) {
  return buildRow('rights_import_failures', {
    import_id: importId,
    row_no: 2,
    reason: 'order_not_found',
    ...values,
  });
}

export async function newAdmin(appId = 'couli'): Promise<unknown> {
  return (await insertRow('admin_users', { app_id: appId, is_super: false }))['id'];
}

export async function assignment(values: Record<string, unknown> = {}) {
  const appId = String(values['app_id'] ?? 'couli');
  return buildRow('order_assignments', {
    order_id: 'order_id' in values ? values['order_id'] : await newOrderId(appId),
    source: 'admin',
    reason: 'synthetic assignment',
    admin_id: 'admin_id' in values ? values['admin_id'] : await newAdmin(appId),
    ...values,
  });
}

/** An order_rights row (04 §3.2) for the order; platform_rights_no defaults to null. */
export function orderRight(orderId: unknown, values: Record<string, unknown> = {}) {
  return buildRow('order_rights', {
    id: randomUUID(),
    order_id: orderId,
    source: 'import',
    type: 'RIGHTS',
    status: 'PROCESSING',
    amount_fen: 100n,
    deduction_commission_fen: 10n,
    occurred_at: FROM,
    platform_rights_no: null,
    ...values,
  });
}
