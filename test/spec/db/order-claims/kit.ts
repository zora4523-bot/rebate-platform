// B1-10a / D10-56: storage contract only; all records below are synthetic fixtures.
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export { sqlState } from '../orders/kit.ts';
export type Table = 'claims' | 'claim_items';
export type Row = Record<string, unknown>;
export const TABLES = ['claims', 'claim_items'] as const;
export const AT = new Date('2026-10-17T15:59:59.000Z');
export const LATER = new Date('2026-10-17T16:00:01.000Z');
export const STATUSES = [
  'submitted',
  'auto_matched',
  'manual_review',
  'approved',
  'rejected',
  'cancelled',
] as const;
export const EVIDENCE = ['strong', 'weak', 'none'] as const;
export const DECISIONS = ['approved', 'rejected', 'cancelled'] as const;
export const REASONS = [
  'NO_EVIDENCE',
  'EXPIRED_CLICK',
  'NOT_TRACKED',
  'OTHER_TLJ',
  'FRAUD',
  'OTHER',
  'NOT_IN_POOL',
  'ORDER_INVALID',
] as const;

// Called inside each test, before any DML or regclass cast of the proposed tables.
export async function ready(db: Kysely<DB>) {
  const result = await sql<{ name: string; kind: string }>`
    SELECT c.relname AS name, c.relkind::text AS kind FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname IN ('claims', 'claim_items')
  `.execute(db);
  expect(new Set(result.rows)).toEqual(new Set(TABLES.map((name) => ({ name, kind: 'r' }))));
}

export async function insert(db: Kysely<DB>, table: string, row: Row) {
  return sql<Row>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((key) => sql.ref(key)))})
    VALUES (${sql.join(Object.values(row))}) RETURNING *`.execute(db);
}

export async function update(db: Kysely<DB>, table: Table, id: unknown, changes: Row) {
  return sql<Row>`UPDATE ${sql.table(`app.${table}`)} SET
    ${sql.join(Object.entries(changes).map(([key, value]) => sql`${sql.ref(key)} = ${value}`))}
    WHERE id = ${id} RETURNING *`.execute(db);
}

export async function user(db: Kysely<DB>, appId = 'couli') {
  const id = randomUUID();
  await insert(db, 'users', {
    id,
    app_id: appId,
    nickname: 'synthetic claimant',
    avatar: '',
    invite_code: id,
    attr_code: id,
    level: 'normal',
    register_method: 'sms',
  });
  return id;
}

export async function admin(db: Kysely<DB>, appId = 'couli') {
  const id = randomUUID();
  await insert(db, 'admin_users', {
    id,
    app_id: appId,
    login_name: `synthetic-${id}`,
    password_hash: 'synthetic-not-a-secret',
    is_super: false,
    status: 'active',
  });
  return id;
}

export async function order(db: Kysely<DB>, changes: Row = {}) {
  const row = {
    app_id: 'couli',
    platform: 'taobao',
    sub_order_id: randomUUID(),
    order_id: randomUUID(),
    attr_at: AT,
    ...changes,
  };
  await insert(db, 'order_keys', row);
  return row;
}

export async function claim(db: Kysely<DB>, changes: Row = {}): Promise<Row> {
  const appId = String(changes['app_id'] ?? 'couli');
  return {
    id: randomUUID(),
    app_id: appId,
    user_id: changes['user_id'] ?? (await user(db, appId)),
    platform: 'taobao',
    order_no: '123-456',
    order_no_type: 'sub',
    paid_date: '2026-10-17',
    evidence_level: null,
    status: 'submitted',
    handler_admin_id: null,
    reason: null,
    created_at: AT,
    updated_at: AT,
    ...changes,
  };
}

export async function savedClaim(db: Kysely<DB>, changes: Row = {}): Promise<Row> {
  const row = await claim(db, changes);
  await insert(db, 'claims', row);
  return row;
}

export async function item(db: Kysely<DB>, parent?: Row, key?: Row): Promise<Row> {
  const c = parent ?? (await savedClaim(db));
  const k = key ?? (await order(db, { app_id: c['app_id'], platform: c['platform'] }));
  return {
    id: randomUUID(),
    app_id: c['app_id'],
    claim_id: c['id'],
    applicant_user_id: c['user_id'],
    platform: c['platform'],
    sub_order_id: k['sub_order_id'],
    order_id: k['order_id'],
    evidence: null,
    evidence_link_log_ids: null,
    decision: null,
    reject_reason: null,
    decided_by: null,
    decided_at: null,
    updated_at: AT,
  };
}

export function decided(decision: string | null): Row {
  return {
    decision,
    reject_reason: decision === 'rejected' ? 'OTHER' : null,
    decided_at: decision === null ? null : LATER,
    decided_by: null,
  };
}
