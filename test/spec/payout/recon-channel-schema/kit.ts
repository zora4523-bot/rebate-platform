// B2-07a rule tests (规划/08 BR-WDR-23; 规划/04 §3.2 recon_channel / payout_recon_runs; 编排裁定
// D10-408): storage contract of the R2 channel reconciliation only, no reconciliation logic.
//   - recon_channel: 04's columns as written (date, out_biz_no, channel_order_id, our_status,
//     channel_status, our_amount_fen, channel_amount_fen, result) plus app_id and bill_date (the
//     Alipay bill the row was read from: a PAID_* near the day boundary is looked up in two bills).
//     One row per interface payout (app_id, bill_date, out_biz_no) and per manual payout
//     (app_id, bill_date, channel_order_id), each a partial unique index.
//   - payout_recon_runs: one row per (app_id, channel, bill_date); a rerun of the day overwrites it.
//     B2-07d counts consecutive succeeded days from it (partial / failed break the run).
// Grants: worker couli_app reads and writes both, couli_payout only reads.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TIMEOUT = 60_000;
export const STARTED = new Date('2032-06-15T01:00:00Z');
export const FINISHED = new Date('2032-06-15T01:05:00Z');
export const BILL_DATE = '2032-06-14';
export const NEXT_BILL_DATE = '2032-06-15';
export const ROLES = ['couli_app', 'couli_payout', 'couli_readonly', 'couli_maint'] as const;
export type Role = (typeof ROLES)[number];
export const TABLES = ['recon_channel', 'payout_recon_runs'] as const;
export type ReconTable = (typeof TABLES)[number];
export type Row = Record<string, unknown>;
export type Connection = Kysely<DB>;
interface Database {
  urlFor(role: Role): string;
  drop(): Promise<void>;
}
export interface Harness {
  database: Database;
  app: Connection;
  roles: Record<Role, Connection>;
}

// [Postgres type, nullable, default]. Business instants (started_at, finished_at) carry no SQL clock
// default (db/AGENTS.md rule 6); the bill side or our side of a recon_channel row may be missing.
export const SHAPES: Record<
  ReconTable,
  Record<string, readonly [string, boolean, string | null]>
> = {
  recon_channel: {
    id: ['uuid', false, null],
    app_id: ['text', false, null],
    date: ['date', false, null],
    bill_date: ['date', false, null],
    out_biz_no: ['text', true, null],
    channel_order_id: ['text', true, null],
    our_status: ['text', true, null],
    channel_status: ['text', true, null],
    our_amount_fen: ['int8', true, null],
    channel_amount_fen: ['int8', true, null],
    result: ['text', false, null],
    created_at: ['timestamptz', false, 'now()'],
    updated_at: ['timestamptz', false, 'now()'],
  },
  payout_recon_runs: {
    id: ['uuid', false, null],
    app_id: ['text', false, null],
    channel: ['text', false, null],
    bill_date: ['date', false, null],
    status: ['text', false, null],
    started_at: ['timestamptz', false, null],
    finished_at: ['timestamptz', false, null],
    bill_rows: ['int4', false, null],
    matched: ['int4', false, null],
    diffs: ['int4', false, null],
    created_at: ['timestamptz', false, 'now()'],
    updated_at: ['timestamptz', false, 'now()'],
  },
};
// recon_channel.result, one value per BR-WDR-23 outcome: matched (bill and withdrawal agree),
// paying_query (① Alipay success, ours PAYING with needs_manual=false: query at once),
// paying_manual (② the same with needs_manual=true: only a pending-disposal hint for W10),
// diff (③ error ticket, alert and recon_diff hold).
export const RESULTS = ['matched', 'paying_query', 'paying_manual', 'diff'];
// withdrawals.status (BR-WDR-08), the only values our_status may snapshot.
export const STATUSES = [
  'PENDING_REVIEW',
  'APPROVED',
  'PAYING',
  'REJECTED',
  'PAID_API',
  'PAID_MANUAL',
  'FAILED',
];
export const RUN_STATUSES = ['succeeded', 'partial', 'failed'];
// R2 reconciles Alipay only for now (D10-408); the CHECK is extended when another channel opens.
export const CHANNELS = ['alipay'];
// Columns a rerun of the same bill day rewrites (couli_app column-level UPDATE).
export const MUTABLE: Record<ReconTable, string[]> = {
  recon_channel: [
    'our_status',
    'channel_status',
    'our_amount_fen',
    'channel_amount_fen',
    'result',
    'updated_at',
  ],
  payout_recon_runs: [
    'status',
    'started_at',
    'finished_at',
    'bill_rows',
    'matched',
    'diffs',
    'updated_at',
  ],
};

export async function open(create: () => Promise<Database>): Promise<Harness> {
  const database = await create();
  const roles = Object.fromEntries(
    ROLES.map((role) => [role, createDb({ connectionString: database.urlFor(role), max: 2 })]),
  ) as Record<Role, Connection>;
  return { database, roles, app: roles.couli_app };
}
export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await Promise.all(Object.values(h.roles).map((db) => destroyDb(db)));
  await h.database.drop();
}
export async function columns(db: Connection, table: ReconTable) {
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
// Every case calls this first: without the migration the case fails on an assertion, not on SQL
// that references a missing table or column.
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
export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !['23502', '23505', '23514', '42501'].includes(code))
      throw error;
    return code;
  }
}
export async function insert(db: Connection, table: ReconTable, row: Row): Promise<void> {
  await sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((name) => sql.ref(name)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}
export async function update(
  db: Connection,
  table: ReconTable,
  id: unknown,
  values: Row,
): Promise<void> {
  await sql`UPDATE ${sql.table(`app.${table}`)} SET
    ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE id = ${id}`.execute(db);
}
export async function stored(db: Connection, table: ReconTable, id: unknown): Promise<Row[]> {
  return (await sql<Row>`SELECT * FROM ${sql.table(`app.${table}`)} WHERE id = ${id}`.execute(db))
    .rows;
}
export function appId(): string {
  return `b207a-${randomUUID()}`;
}
// An interface payout matched by out_biz_no on the bill of BILL_DATE.
export function line(app_id: string, values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id,
    date: BILL_DATE,
    bill_date: BILL_DATE,
    out_biz_no: `W${randomUUID().replaceAll('-', '')}`,
    channel_order_id: `2032${randomUUID().replaceAll('-', '')}`,
    our_status: 'PAID_API',
    channel_status: 'SUCCESS',
    our_amount_fen: 10000n,
    channel_amount_fen: 10000n,
    result: 'matched',
    ...values,
  };
}
// A manual successful payout: no out_biz_no on the bill, matched by channel_order_id.
export function manualLine(app_id: string, values: Row = {}): Row {
  return line(app_id, { out_biz_no: null, our_status: 'PAID_MANUAL', ...values });
}
export function run(app_id: string, values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id,
    channel: 'alipay',
    bill_date: BILL_DATE,
    status: 'succeeded',
    started_at: STARTED,
    finished_at: FINISHED,
    bill_rows: 12,
    matched: 11,
    diffs: 1,
    ...values,
  };
}
export function sample(table: ReconTable, app_id: string, values: Row = {}): Row {
  return table === 'recon_channel' ? line(app_id, values) : run(app_id, values);
}
