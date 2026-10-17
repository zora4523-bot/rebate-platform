// B2-01g: storage only (BR-CALC-10/27 and the task's funds-quote supplement).
// No SQL skeleton: every case asserts table presence before touching a new relation.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { insert, sqlState, version, type Row } from '../rules/kit.ts';
export { columns, insert, sqlState, type Row } from '../rules/kit.ts';

export const SPLITS = 'commission_splits';
export const AMOUNTS = 'commission_split_amounts';
export const EVENTS = 'commission_split_beneficiary_events';
export const TOTALS = 'commission_split_totals';
export const TABLES = [SPLITS, AMOUNTS, EVENTS, TOTALS] as const;
export type Table = (typeof TABLES)[number];
export const ROLES = ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint'] as const;
export type Role = (typeof ROLES)[number];
export const TIMEOUT = 60_000;
export const AT = new Date('2032-04-01T08:00:00Z');

interface Database {
  urlFor(role: Role): string;
  drop(): Promise<void>;
}
export interface Harness {
  database: Database;
  connections: Record<Role, Kysely<DB>>;
  app: Kysely<DB>;
}

export async function open(create: () => Promise<Database>): Promise<Harness> {
  const database = await create();
  const connections = Object.fromEntries(
    ROLES.map((role) => [role, createDb({ connectionString: database.urlFor(role), max: 2 })]),
  ) as Record<Role, Kysely<DB>>;
  return { database, connections, app: connections.couli_app };
}

export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await Promise.all(Object.values(h.connections).map((db) => destroyDb(db)));
  await h.database.drop();
}

export async function ready(db: Kysely<DB>): Promise<void> {
  for (const table of TABLES) {
    const result = await sql<{ kind: string }>`SELECT c.relkind::text AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relname = ${table}`.execute(db);
    expect(result.rows, `B2-01g must create app.${table}`).toEqual([{ kind: 'r' }]);
  }
}

export interface Fixture {
  appId: string;
  orderId: string;
  userId: string;
  versionId: string;
}

export async function fixture(db: Kysely<DB>, appId = `b201g-${randomUUID()}`): Promise<Fixture> {
  const parent = await version(db, { app_id: appId });
  const orderId = randomUUID();
  const userId = randomUUID();
  expect(
    await sqlState(
      insert(db, 'order_keys', {
        app_id: appId,
        order_id: orderId,
        platform: 'taobao',
        sub_order_id: randomUUID(),
        attr_at: AT,
      }),
    ),
  ).toBe('ok');
  expect(
    await sqlState(
      insert(db, 'users', {
        id: userId,
        app_id: appId,
        nickname: 'synthetic',
        avatar: '',
        invite_code: randomUUID(),
        attr_code: randomUUID(),
        level: 'L1',
        register_method: 'phone',
      }),
    ),
  ).toBe('ok');
  return { appId, orderId, userId, versionId: String(parent['rule_version_id']) };
}

export function row(table: Table, f: Fixture, values: Row = {}): Row {
  const common = { app_id: f.appId, order_id: f.orderId, created_at: AT };
  const rows: Record<Table, Row> = {
    [SPLITS]: {
      ...common,
      rule_version_id: f.versionId,
      order_type: 'self',
      activity_type: 'normal',
      rebate_mode: null,
      paid_at: AT,
      paid_at_source: 'platform',
      raw_n_fen: 1000n,
      subsidy_commission_fen: 0n,
      reserve_bp: 1500,
      reserve_fen: 150n,
      tlj_deduct_fen: 0n,
      base_fen: 850n,
      platform_retain_fen: 425n,
      beneficiaries: JSON.stringify([
        {
          user_id: f.userId,
          role: 'self',
          ratio_bp: 5000,
          level: 'L1',
          initial_status: 'active',
          forfeit_reason: null,
        },
      ]),
    },
    [AMOUNTS]: {
      ...common,
      commission_version: 1,
      user_id: f.userId,
      role: 'self',
      base_fen: 850n,
      amount_fen: 425n,
    },
    [EVENTS]: { ...common, user_id: f.userId, role: 'self', status: 'active', reason: null },
    [TOTALS]: {
      ...common,
      commission_version: 1,
      n_total_fen: 1000n,
      pre_base_deduct_fen: 150n,
      base_fen: 850n,
      user_share_total_fen: 425n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 575n,
    },
  };
  return { ...rows[table], ...values };
}

export async function stored(db: Kysely<DB>, table: Table, orderId: string): Promise<Row[]> {
  return (
    await sql<Row>`SELECT * FROM ${sql.table(`app.${table}`)}
    WHERE order_id = ${orderId}`.execute(db)
  ).rows;
}
