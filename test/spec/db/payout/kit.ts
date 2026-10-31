// B2-05b: storage fixtures only; no service/state-machine implementation.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TIMEOUT = 60_000;
export const AT = new Date('2032-06-15T02:00:00Z');
export const ROLES = ['couli_app', 'couli_payout', 'couli_readonly', 'couli_maint'] as const;
export type Role = (typeof ROLES)[number];
export type Table = 'withdrawals' | 'withdraw_holds';
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

// [Postgres type, nullable, default]. No unspecified defaults are invented.
export const SHAPES: Record<Table, Record<string, readonly [string, boolean, string | null]>> = {
  withdrawals: {
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
    review_overdue_at: ['timestamptz', true, null],
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
  },
  withdraw_holds: {
    id: ['uuid', false, null],
    app_id: ['text', false, null],
    user_id: ['uuid', false, null],
    reason: ['text', false, null],
    source_ref: ['text', true, null],
    created_by: ['text', false, null],
    created_at: ['timestamptz', false, 'now()'],
    hold_until: ['timestamptz', true, null],
    released_at: ['timestamptz', true, null],
    released_by: ['text', true, null],
  },
};
export const APP_UPDATES = [
  'status',
  'review_mode',
  'auto_decision',
  'review_deadline',
  'review_overdue_at',
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
export const PAYOUT_UPDATES = [
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
export const STATUSES = [
  'PENDING_REVIEW',
  'APPROVED',
  'PAYING',
  'REJECTED',
  'PAID_API',
  'PAID_MANUAL',
  'FAILED',
];
export const REASONS = ['manual', 'recon_diff', 'ledger_mismatch', 'manual_failed_watch'];
export const REJECT_REASONS = [
  'RISK_SUSPECT',
  'ORDER_ABNORMAL',
  'PAYEE_INFO_INVALID',
  'USER_REQUEST',
  'OTHER',
  'NEGATIVE_BALANCE',
];
export const HOLD_REASONS = [
  'payout_disabled',
  'queue_paused',
  'channel_disabled',
  'member_blocked',
  'single_cap',
  'daily_cap',
  'payer_side_after_transfer',
];

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
export async function columns(db: Connection, table: Table) {
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
// Every case calls this before fixture SQL: missing migration is assertion-red.
export async function ready(db: Connection, table: Table = 'withdrawals'): Promise<void> {
  const found = await sql<{
    name: string | null;
  }>`SELECT to_regclass(${`app.${table}`})::text AS name`.execute(db);
  expect(found.rows).toEqual([{ name: `app.${table}` }]);
  expect((await columns(db, table)).map((c) => c.name)).toEqual(
    expect.arrayContaining(Object.keys(SHAPES[table])),
  );
}
export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (
      typeof code !== 'string' ||
      !['23502', '23503', '23505', '23514', '42501', '23001'].includes(code)
    )
      throw error;
    return code;
  }
}
export async function insert(db: Connection, table: string, row: Row): Promise<void> {
  await sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((name) => sql.ref(name)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}
export async function update(
  db: Connection,
  table: Table,
  id: unknown,
  values: Row,
): Promise<void> {
  await sql`UPDATE ${sql.table(`app.${table}`)} SET
    ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE id = ${id}`.execute(db);
}
export async function stored(db: Connection, table: Table, id: unknown): Promise<Row[]> {
  return (await sql<Row>`SELECT * FROM ${sql.table(`app.${table}`)} WHERE id = ${id}`.execute(db))
    .rows;
}
export async function person(db: Connection, appId = `b205b-${randomUUID()}`) {
  const userId = randomUUID();
  await insert(db, 'users', {
    id: userId,
    app_id: appId,
    nickname: 'fixture',
    avatar: 'fixture',
    invite_code: randomUUID(),
    attr_code: randomUUID(),
    level: 'L1',
    register_method: 'phone',
  });
  return { app_id: appId, user_id: userId };
}
export function withdrawal(owner: { app_id: string; user_id: string }, values: Row = {}): Row {
  return {
    id: randomUUID(),
    ...owner,
    amount_fen: 1000n,
    fee_fen: 0n,
    tax_fen: 0n,
    net_fen: 1000n,
    income_type: 'SERVICE_FEE',
    payout_method: 'alipay',
    payee_name: '测试人',
    payee_account_cipher: Buffer.from('synthetic-cipher'),
    payee_hmac: 'synthetic-hmac',
    status: 'PENDING_REVIEW',
    out_biz_no: randomUUID().replaceAll('-', ''),
    payout_channel: 'alipay',
    created_at: AT,
    updated_at: AT,
    ...values,
  };
}
export function hold(owner: { app_id: string; user_id: string }, values: Row = {}): Row {
  return {
    id: randomUUID(),
    ...owner,
    reason: 'manual',
    created_by: 'system:fixture',
    created_at: AT,
    ...values,
  };
}
export function statusFields(status: string): Row {
  return {
    status,
    ...(status === 'REJECTED' ? { reject_reason_code: 'OTHER' } : {}),
    ...(['PAID_API', 'PAID_MANUAL'].includes(status) ? { paid_at: AT } : {}),
    ...(status === 'PAID_MANUAL'
      ? { manual_entry_by: randomUUID(), manual_confirm_by: randomUUID() }
      : {}),
  };
}
