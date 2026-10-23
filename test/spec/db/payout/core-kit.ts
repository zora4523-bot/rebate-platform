// B2-06a §9 is the concrete storage contract; no payout service logic lives here.
import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { expect } from 'vitest';

import { AT, insert, person, withdrawal, type Connection, type Harness, type Row } from './kit.ts';

export const TABLES = [
  'payout_batches',
  'payout_batch_items',
  'payout_attempts',
  'payout_watermarks',
] as const;
export type CoreTable = (typeof TABLES)[number];
export const COMPLETION_COLUMNS = [
  'response',
  'resp_code',
  'resp_sub_code',
  'result',
  'latency_ms',
];
export const SHAPES: Record<
  CoreTable,
  Record<string, readonly [string, boolean, string | null]>
> = {
  payout_batches: {
    id: ['uuid', false, null],
    app_id: ['text', false, null],
    kind: ['text', false, null],
    created_by: ['text', true, null],
    created_at: ['timestamptz', false, 'now()'],
  },
  payout_batch_items: {
    id: ['uuid', false, null],
    app_id: ['text', false, null],
    batch_id: ['uuid', false, null],
    withdrawal_id: ['uuid', false, null],
    result: ['text', false, null],
    reason: ['text', true, null],
    moved_to_batch_id: ['uuid', true, null],
    at: ['timestamptz', false, 'now()'],
  },
  payout_attempts: {
    id: ['uuid', false, null],
    app_id: ['text', false, null],
    withdrawal_id: ['uuid', false, null],
    kind: ['text', false, null],
    request: ['jsonb', false, null],
    response: ['jsonb', true, null],
    resp_code: ['text', true, null],
    resp_sub_code: ['text', true, null],
    result: ['text', false, null],
    latency_ms: ['int4', true, null],
    at: ['timestamptz', false, 'now()'],
  },
  payout_watermarks: {
    id: ['uuid', false, null],
    app_id: ['text', false, null],
    channel: ['text', false, null],
    available_fen: ['int8', false, null],
    measured_at: ['timestamptz', false, null],
    entered_by: ['text', false, null],
    created_at: ['timestamptz', false, 'now()'],
  },
};

export async function columns(db: Connection, table: CoreTable) {
  return (
    await sql<{ name: string; type: string; nullable: boolean; default_expr: string | null }>`
      SELECT a.attname::text AS name, t.typname::text AS type, NOT a.attnotnull AS nullable,
        pg_get_expr(d.adbin, d.adrelid) AS default_expr
      FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass(${`app.${table}`}) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`.execute(db)
  ).rows;
}

// Fail on a real assertion before SQL references missing tables/columns in the red phase.
export async function ready(db: Connection): Promise<void> {
  for (const table of TABLES) {
    const found = await sql<{ name: string | null }>`
      SELECT to_regclass(${`app.${table}`})::text AS name`.execute(db);
    expect(found.rows, table).toEqual([{ name: `app.${table}` }]);
    expect(
      (await columns(db, table)).map((c) => c.name),
      table,
    ).toEqual(expect.arrayContaining(Object.keys(SHAPES[table])));
  }
}

export function batch(app_id: unknown, values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id,
    kind: 'manual',
    created_by: 'finance:fixture',
    created_at: AT,
    ...values,
  };
}
export function watermark(app_id: unknown, values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id,
    channel: 'alipay',
    available_fen: 1000n,
    measured_at: AT,
    entered_by: 'finance:fixture',
    created_at: AT,
    ...values,
  };
}
export async function fixture(h: Harness) {
  const owner = await person(h.app);
  const source = batch(owner.app_id, { kind: 'auto', created_by: null });
  const target = batch(owner.app_id);
  const wd = withdrawal(owner, { status: 'APPROVED', batch_id: source['id'] });
  await insert(h.app, 'payout_batches', source);
  await insert(h.app, 'payout_batches', target);
  await insert(h.app, 'withdrawals', wd);
  return { owner, source, target, wd };
}
export function item(f: Awaited<ReturnType<typeof fixture>>, values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: f.owner.app_id,
    batch_id: f.source['id'],
    withdrawal_id: f.wd['id'],
    result: 'paying',
    reason: null,
    moved_to_batch_id: null,
    at: AT,
    ...values,
  };
}
export function attempt(f: Awaited<ReturnType<typeof fixture>>, values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: f.owner.app_id,
    withdrawal_id: f.wd['id'],
    kind: 'transfer',
    request: JSON.stringify({ logon_id: 'f***@example.invalid' }),
    response: null,
    resp_code: null,
    resp_sub_code: null,
    result: 'pending',
    latency_ms: null,
    at: AT,
    ...values,
  };
}
export function writer(h: Harness, table: CoreTable): Connection {
  return table === 'payout_attempts' ? h.roles.couli_payout : h.app;
}
export async function stored(db: Connection, table: CoreTable, id: unknown): Promise<Row[]> {
  return (await sql<Row>`SELECT * FROM ${sql.table(`app.${table}`)} WHERE id = ${id}`.execute(db))
    .rows;
}
export async function update(
  db: Connection,
  table: CoreTable,
  id: unknown,
  values: Row,
): Promise<void> {
  await sql`UPDATE ${sql.table(`app.${table}`)} SET
    ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE id = ${id}`.execute(db);
}
