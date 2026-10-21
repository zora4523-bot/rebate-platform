// CT-25b §9.2: storage contract only; eligibility/award decisions belong to B1-35.
// The integration globalSetup reads TEST_PG_ADMIN_URL and clones migrated databases.
// Business queries use couli_app/couli_readonly; no admin connection or cleanup DELETE.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export type Connection = Kysely<DB>;
export type Row = Record<string, unknown>;
export const TABLES = ['invite_rewards', 'invite_reward_budgets'] as const;
export type Table = (typeof TABLES)[number];
export const AT = new Date('2026-10-19T15:59:59.999Z');
export const NEXT = new Date('2026-10-19T16:00:00.000Z');
export const IP = 'a'.repeat(64);
export const REASONS = [
  'same_device',
  'same_ip',
  'deleted_phone_retained',
  'multi_account',
  'risk_restricted',
  'deleting',
  'minor',
] as const;
export const VOID_REASONS = ['relation_changed', 'order_clawed_back', 'order_rights'] as const;

// [PostgreSQL type, nullable, default expression]. No extra lifecycle defaults are prescribed.
export const SHAPES: Record<Table, Record<string, readonly [string, boolean, string | null]>> = {
  invite_rewards: {
    app_id: ['text', false, null],
    invitee_id: ['uuid', false, null],
    inviter_id: ['uuid', false, null],
    amount_fen: ['int8', false, null],
    qualified_at: ['timestamptz', false, null],
    bind_source: ['text', false, null],
    bind_ip_hmac: ['text', false, null],
    trigger_order_id: ['uuid', true, null],
    triggered_at: ['timestamptz', true, null],
    status: ['text', false, null],
    inviter_result: ['text', true, null],
    invitee_result: ['text', true, null],
    inviter_skip_reason: ['text', true, null],
    invitee_skip_reason: ['text', true, null],
    void_reason: ['text', true, null],
    inviter_voucher_id: ['uuid', true, null],
    invitee_voucher_id: ['uuid', true, null],
    granted_at: ['timestamptz', true, null],
    row_version: ['int4', false, '0'],
  },
  invite_reward_budgets: {
    app_id: ['text', false, null],
    period: ['text', false, null],
    reserved_fen: ['int8', false, '0'],
    granted_fen: ['int8', false, '0'],
    row_version: ['int4', false, '0'],
    updated_at: ['timestamptz', false, 'now()'],
  },
};
export const UPDATABLE: Record<Table, readonly string[]> = {
  invite_rewards: [
    'trigger_order_id',
    'triggered_at',
    'status',
    'inviter_result',
    'invitee_result',
    'inviter_skip_reason',
    'invitee_skip_reason',
    'void_reason',
    'inviter_voucher_id',
    'invitee_voucher_id',
    'granted_at',
    'row_version',
  ],
  invite_reward_budgets: ['reserved_fen', 'granted_fen', 'row_version', 'updated_at'],
};
// CT-25e: CT-25d adds the locked eligibility_days column (04 §3.2; BR-INV-24) and swaps
// budget_exhausted for expired in invite_rewards_status_check. F1-02zt：过渡已收紧, only that form
// is accepted: the 0055 table, the column without the new status set, or the new status set
// without the column fails expectForm.
export const ELIGIBILITY_COLUMN: Record<string, readonly [string, boolean, string | null]> = {
  eligibility_days: ['int4', false, null],
};
/** SHAPES plus the CT-25d column: the exact column set of the table under test. */
export const SHAPES_NOW: typeof SHAPES = {
  ...SHAPES,
  invite_rewards: { ...SHAPES.invite_rewards, ...ELIGIBILITY_COLUMN },
};
export const STATUS_TERMINAL = 'expired';
export const STATUS_RETIRED = 'budget_exhausted';
const forms = new WeakMap<Connection, Promise<void>>();
export function expectForm(db: Connection): Promise<void> {
  let form = forms.get(db);
  if (!form) {
    form = detect(db);
    forms.set(db, form);
  }
  return form;
}
async function detect(db: Connection): Promise<void> {
  const column = await sql<{ name: string }>`SELECT column_name::text AS name
    FROM information_schema.columns WHERE table_schema = 'app'
      AND table_name = 'invite_rewards' AND column_name = 'eligibility_days'`.execute(db);
  const status = await sql<{ definition: string }>`SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid = to_regclass('app.invite_rewards')
      AND conname = 'invite_rewards_status_check'`.execute(db);
  expect(status.rows, 'invite_rewards_status_check must exist').toHaveLength(1);
  const definition = status.rows[0]!.definition;
  const accepts = {
    budget_exhausted: /'budget_exhausted'/.test(definition),
    expired: /'expired'/.test(definition),
  };
  expect(column.rows.length, 'eligibility_days appears exactly once').toBe(1);
  expect(accepts, definition).toEqual({ budget_exhausted: false, expired: true });
}
// Orchestrator mechanical fix: @couli/db/testing may only be imported by *.int.test.ts
// (dependency rule testcontainers-only-in-int-tests); the int tests pass createTestDatabase in.
export interface TestDatabaseLike {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}
export interface Harness {
  database: TestDatabaseLike;
  app: Connection;
  readonly: Connection;
}
export async function open(create: () => Promise<TestDatabaseLike>): Promise<Harness> {
  const database = await create();
  return {
    database,
    app: createDb({ connectionString: database.urlFor('couli_app'), max: 4 }),
    readonly: createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 }),
  };
}
export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await Promise.all([destroyDb(h.app), destroyDb(h.readonly)]);
  await h.database.drop();
}
export async function ready(db: Connection): Promise<void> {
  for (const table of TABLES) {
    const result = await sql<{ kind: string }>`SELECT relkind::text AS kind
      FROM pg_class WHERE oid = to_regclass(${`app.${table}`})`.execute(db);
    // Missing migration must be an assertion failure, not undefined_table or a hook error.
    expect(result.rows, `CT-25b must create app.${table}`).toEqual([{ kind: 'r' }]);
  }
}
export function appId(): string {
  return `ct25b_${randomUUID().replaceAll('-', '')}`;
}
export async function insert(db: Connection, table: string, row: Row): Promise<Row> {
  const saved = await sql<Row>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((key) => sql.ref(key)))})
    VALUES (${sql.join(Object.values(row))}) RETURNING *`.execute(db);
  expect(saved.rows).toHaveLength(1);
  return saved.rows[0]!;
}
export async function user(db: Connection, app: string): Promise<string> {
  const id = randomUUID();
  await insert(db, 'users', {
    id,
    app_id: app,
    nickname: 'synthetic',
    avatar: '',
    invite_code: randomUUID(),
    attr_code: randomUUID(),
    level: 'L1',
    register_method: 'phone',
  });
  return id;
}
export async function reward(db: Connection, app = appId()): Promise<Row> {
  // CT-25e: BR-INV-24 default of 30 days, written explicitly (no database default is relied on).
  // F1-02zt：过渡已收紧, the column must exist.
  await expectForm(db);
  return {
    app_id: app,
    invitee_id: await user(db, app),
    inviter_id: await user(db, app),
    amount_fen: 100n,
    qualified_at: AT,
    bind_source: 'register',
    bind_ip_hmac: IP,
    status: 'qualified',
    eligibility_days: 30,
  };
}
export async function references(db: Connection, app: string) {
  const order = randomUUID();
  const voucher = randomUUID();
  await insert(db, 'order_keys', {
    app_id: app,
    order_id: order,
    platform: 'taobao',
    sub_order_id: randomUUID(),
    attr_at: AT,
  });
  await insert(db, 'ledger_vouchers', {
    id: voucher,
    app_id: app,
    biz_type: 'invite_reward',
    biz_id: randomUUID(),
    uniq_key: randomUUID(),
    accounting_date: '2026-10-19',
    operator: 'synthetic:ct25b',
  });
  return { order, voucher };
}
export async function update(db: Connection, table: Table, app: unknown, changes: Row) {
  return sql<Row>`UPDATE ${sql.table(`app.${table}`)} SET
    ${sql.join(Object.entries(changes).map(([key, value]) => sql`${sql.ref(key)} = ${value}`))}
    WHERE app_id = ${app} RETURNING *`.execute(db);
}
