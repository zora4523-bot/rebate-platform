// B2-05m rule tests (规划/08 BR-WDR-26「审核时效与结果通知」: 超时检查任务每 5 分钟运行一次，
// 判定时状态仍 ∈ {PENDING_REVIEW, APPROVED} 即为审核超时，每单只判定一次; 编排裁定 D10-467 ④、
// D10-475 ②(c)): storage contract of app.withdrawals.review_overdue_at only — no overdue judgement
// (B2-05n), no metric (B2-05o), no backfill, no contract change.
//   - review_overdue_at timestamptz, nullable, no default. NULL = not judged yet; non-NULL = the
//     instant the overdue check judged the withdrawal overdue (its status then ∈ {PENDING_REVIEW,
//     APPROVED}). The schema keeps no CHECK on it: "terminal rows are not written" is the task's.
//   - Grants follow 0075's column ownership: UPDATE (review_overdue_at) only to couli_app (the worker
//     running the payout-overdue queue, same process as payout-review); couli_payout and
//     couli_readonly read it through their table-level SELECT and gain no write; couli_maint nothing.
//   - Every existing column, constraint, index and trigger of app.withdrawals stays as main's
//     db/schema.sql has it (only the column is added).
import { randomBytes, randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TIMEOUT = 60_000;
export const COLUMN = 'review_overdue_at';
export const ROLES = ['couli_app', 'couli_payout', 'couli_readonly', 'couli_maint'] as const;
export type Role = (typeof ROLES)[number];
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

// [Postgres type, nullable, default] of app.withdrawals on main (db/schema.sql, 0075).
export const EXISTING: Record<string, readonly [string, boolean, string | null]> = {
  id: ['uuid', false, null],
  app_id: ['text', false, null],
  user_id: ['uuid', false, null],
  amount_fen: ['int8', false, null],
  fee_fen: ['int8', false, null],
  tax_fen: ['int8', false, null],
  net_fen: ['int8', false, null],
  income_type: ['text', false, null],
  fee_rule_id: ['uuid', true, null],
  tax_rule_version: ['text', true, null],
  payout_method: ['text', false, null],
  payee_name: ['text', false, null],
  payee_account_cipher: ['bytea', false, null],
  payee_hmac: ['text', false, null],
  bank_name: ['text', true, null],
  wechat_app_id: ['text', true, null],
  channel_state: ['text', true, null],
  confirm_deadline: ['timestamptz', true, null],
  wechat_launch_cipher: ['bytea', true, null],
  status: ['text', false, null],
  out_biz_no: ['text', false, null],
  review_mode: ['text', true, null],
  auto_decision: ['jsonb', true, null],
  review_deadline: ['timestamptz', true, null],
  reviewer_id: ['uuid', true, null],
  reviewed_at: ['timestamptz', true, null],
  reject_reason_code: ['text', true, null],
  reject_note: ['text', true, null],
  fail_code: ['text', true, null],
  executor_id: ['uuid', true, null],
  executed_at: ['timestamptz', true, null],
  batch_id: ['uuid', true, null],
  execute_seq: ['int4', false, '0'],
  needs_manual: ['bool', false, 'false'],
  manual_resolution: ['text', true, null],
  resolver_ids: ['jsonb', true, null],
  proof_file: ['text', true, null],
  manual_entry_by: ['uuid', true, null],
  manual_confirm_by: ['uuid', true, null],
  hold_reason: ['text', true, null],
  hold_at: ['timestamptz', true, null],
  blocked_reason: ['text', true, null],
  risk_flags: ['jsonb', true, null],
  risk_flags_at: ['timestamptz', true, null],
  payout_channel: ['text', false, null],
  paid_at: ['timestamptz', true, null],
  channel_order_id: ['text', true, null],
  row_version: ['int4', false, '0'],
  created_at: ['timestamptz', false, 'now()'],
  updated_at: ['timestamptz', false, 'now()'],
};
// The new column: a business instant written by the overdue check from its injected Clock, so no
// SQL clock default (db/AGENTS.md rule 6) and NULL until judged.
export const ADDED = ['timestamptz', true, null] as const;
export const SHAPE: Record<string, readonly [string, boolean, string | null]> = {
  ...EXISTING,
  [COLUMN]: ADDED,
};

// Column-level UPDATE of 0075 (unchanged on main): couli_app (api / worker / admin entries) and
// couli_payout (payout process). B2-05m adds review_overdue_at to couli_app's list only.
export const APP_UPDATE = [
  'status',
  'review_mode',
  'auto_decision',
  'review_deadline',
  'reviewer_id',
  'reviewed_at',
  'reject_reason_code',
  'reject_note',
  'blocked_reason',
  'hold_reason',
  'hold_at',
  'executor_id',
  'executed_at',
  'batch_id',
  'execute_seq',
  'risk_flags',
  'risk_flags_at',
  'paid_at',
  'channel_order_id',
  'fail_code',
  'manual_resolution',
  'resolver_ids',
  'proof_file',
  'manual_entry_by',
  'manual_confirm_by',
  'row_version',
  'updated_at',
];
export const PAYOUT_UPDATE = [
  'status',
  'needs_manual',
  'manual_resolution',
  'resolver_ids',
  'proof_file',
  'manual_entry_by',
  'manual_confirm_by',
  'fail_code',
  'paid_at',
  'channel_order_id',
  'channel_state',
  'confirm_deadline',
  'wechat_launch_cipher',
  'hold_reason',
  'hold_at',
  'executor_id',
  'executed_at',
  'batch_id',
  'execute_seq',
  'row_version',
  'updated_at',
];

// Constraints of app.withdrawals on main (db/schema.sql), by name and pg_constraint.contype.
export const CONSTRAINTS: Record<string, string> = {
  withdrawals_pkey: 'p',
  withdrawals_app_id_id_key: 'u',
  withdrawals_out_biz_no_key: 'u',
  withdrawals_user_fkey: 'f',
  withdrawals_batch_fkey: 'f',
  ...Object.fromEntries(
    [
      'amount',
      'auto_decision',
      'bank_name',
      'blocked_reason',
      'channel_order_id',
      'channel_state',
      'execute_seq',
      'fee',
      'hold_at',
      'hold_reason',
      'income_type',
      'manual_resolution',
      'needs_manual',
      'net',
      'out_biz_no',
      'paid',
      'paid_manual',
      'payee_hmac',
      'payee_name',
      'payout_channel',
      'payout_method',
      'reject_reason',
      'rejected',
      'resolver_ids',
      'review_mode',
      'risk_flags',
      'row_version',
      'status',
      'tax',
      'wechat_app_id',
      'wechat_only',
    ].map((name) => [`withdrawals_${name}_check`, 'c']),
  ),
};
// Indexes of app.withdrawals on main: key columns, unique, predicate (normalised: casts, brackets,
// quotes and spaces removed; null = whole table).
export const INDEXES: Record<
  string,
  { keys: string[]; unique: boolean; predicate: string | null }
> = {
  withdrawals_pkey: { keys: ['id'], unique: true, predicate: null },
  withdrawals_app_id_id_key: { keys: ['app_id', 'id'], unique: true, predicate: null },
  withdrawals_out_biz_no_key: { keys: ['app_id', 'out_biz_no'], unique: true, predicate: null },
  withdrawals_channel_order_id_key: {
    keys: ['app_id', 'channel_order_id'],
    unique: true,
    predicate: 'channel_order_idISNOTNULL',
  },
  withdrawals_open_idx: {
    keys: ['app_id', 'user_id'],
    unique: false,
    predicate: "status=ANYARRAY'PENDING_REVIEW','APPROVED','PAYING'",
  },
  withdrawals_payee_created_idx: {
    keys: ['app_id', 'payee_hmac', 'created_at'],
    unique: false,
    predicate: null,
  },
  withdrawals_user_created_idx: {
    keys: ['app_id', 'user_id', 'created_at'],
    unique: false,
    predicate: null,
  },
};
export function normalisePredicate(predicate: string | null): string | null {
  return predicate === null ? null : predicate.replaceAll(/::text|[()[\]\s"]/g, '');
}
// The only (non-internal) trigger on main: out_biz_no is never rewritten (BR-WDR-07).
export const TRIGGERS = ['withdrawals_out_biz_no_fixed'];

const CODES = ['23502', '23503', '23505', '23514', '42501'];

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
export async function columns(db: Connection) {
  return (
    await sql<{ name: string; type: string; nullable: boolean; default_expr: string | null }>`
      SELECT a.attname::text AS name, t.typname::text AS type, NOT a.attnotnull AS nullable,
        pg_get_expr(d.adbin, d.adrelid) AS default_expr
      FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass('app.withdrawals') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`.execute(db)
  ).rows;
}
// Every database case calls this first: without the migration the case fails on this assertion,
// not on SQL that names a missing column (42703).
export async function ready(db: Connection): Promise<void> {
  expect((await columns(db)).map((c) => c.name)).toEqual(expect.arrayContaining([COLUMN]));
}
export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !CODES.includes(code)) throw error;
    return code;
  }
}
export async function insert(db: Connection, row: Row): Promise<void> {
  await sql`INSERT INTO app.withdrawals
    (${sql.join(Object.keys(row).map((name) => sql.ref(name)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}
export async function update(db: Connection, id: unknown, values: Row): Promise<void> {
  await sql`UPDATE app.withdrawals SET
    ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE id = ${id}`.execute(db);
}
export async function stored(db: Connection, id: unknown): Promise<Row[]> {
  return (await sql<Row>`SELECT * FROM app.withdrawals WHERE id = ${id}`.execute(db)).rows;
}
export function appId(): string {
  return `b205m-${randomUUID()}`;
}
// A member of `app` (the foreign key target); couli_app registers members.
export async function member(db: Connection, app: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status)
    VALUES (${id}, ${app}, 'fixture', 'fixture', ${randomBytes(4).toString('hex')},
      ${randomBytes(5).toString('hex')}, 'L1', 'sms', 'normal')`.execute(db);
  return id;
}
// A manual-review alipay withdrawal of ¥100 in PENDING_REVIEW (BR-WDR-26 例: 周三 10:00 提交 →
// deadline 周四 10:00, +08:00), without review_overdue_at: the column list of every existing insert.
export function withdrawal(app: string, user: string, values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: app,
    user_id: user,
    amount_fen: 10000n,
    fee_fen: 0n,
    tax_fen: 0n,
    net_fen: 10000n,
    income_type: 'SERVICE_FEE',
    payout_method: 'alipay',
    payee_name: '合成姓名',
    payee_account_cipher: Buffer.from('synthetic-encrypted-account'),
    payee_hmac: randomBytes(32).toString('hex'),
    status: 'PENDING_REVIEW',
    out_biz_no: randomBytes(16).toString('hex'),
    payout_channel: 'alipay',
    review_mode: 'manual',
    review_deadline: new Date('2032-10-21T02:00:00.000Z'),
    created_at: new Date('2032-10-20T02:00:00.000Z'),
    ...values,
  };
}
/** A member and a withdrawal of a fresh App, inserted by couli_app. */
export async function seed(db: Connection, values: Row = {}): Promise<Row> {
  const app = appId();
  const row = withdrawal(app, await member(db, app), values);
  await insert(db, row);
  return row;
}
// The instant the overdue check judges the 例's withdrawal: deadline 周四 10:00 → judged by 10:05.
export const JUDGED_AT = new Date('2032-10-21T02:05:00.000Z');
