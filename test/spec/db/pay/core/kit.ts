// B2-15a：仅数据库存储规则；不执行支付、退款、开通或账务业务。
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';

export const TABLES = [
  'pay_orders',
  'pay_notifications',
  'pay_query_attempts',
  'pay_refunds',
  'pay_anomalies',
  'pay_fulfillments',
] as const;
export type Table = (typeof TABLES)[number];
export type Row = Record<string, unknown>;
export type Connection = Kysely<DB>;
export const AT = new Date('2032-06-15T00:00:00Z');
export const LATER = new Date('2032-06-15T01:00:00Z');
export const ROLES = ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint'] as const;
type Role = (typeof ROLES)[number];
interface Database {
  urlFor(role: Role): string;
  drop(): Promise<void>;
}

export function harness(factory: () => Promise<Database>) {
  let database: Database | undefined;
  const connections = new Map<Role, Connection>();
  beforeAll(async () => {
    database = await factory();
  }, 60_000);
  afterAll(async () => {
    await Promise.all([...connections.values()].map(destroyDb));
    await database?.drop();
  }, 60_000);
  return {
    db(role: Role = 'couli_app'): Connection {
      const existing = connections.get(role);
      if (existing) return existing;
      if (!database) throw new Error('Test database has not been provisioned');
      const connection = createDb({ connectionString: database.urlFor(role), max: 3 });
      connections.set(role, connection);
      return connection;
    },
  };
}

// 每条测试先调用：未落迁移时只产生 AssertionError，不产生缺表 SQL 错误。
export async function ready(db: Connection) {
  for (const table of TABLES) {
    const result = await sql`SELECT to_regclass(${`app.${table}`}) IS NOT NULL AS present`.execute(
      db,
    );
    expect(result.rows, `missing app.${table}`).toEqual([{ present: true }]);
  }
}
export function insert(db: Connection, table: Table | 'users', row: Row) {
  return sql<Row>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((key) => sql.ref(key)))})
    VALUES (${sql.join(Object.values(row))}) RETURNING *`.execute(db);
}
export function update(db: Connection, table: Table, row: Row, change: Row) {
  return sql<Row>`UPDATE ${sql.table(`app.${table}`)} SET
    ${sql.join(Object.entries(change).map(([key, value]) => sql`${sql.ref(key)} = ${value}`))}
    WHERE app_id = ${row['app_id']} AND id = ${row['id']} RETURNING *`.execute(db);
}
export async function rejects(run: Promise<unknown>, code: string) {
  await expect(run).rejects.toMatchObject({ code });
}
export async function columns(db: Connection, table: Table) {
  return (
    await sql<{ name: string; type: string; nullable: boolean; expression: string | null }>`
    SELECT column_name AS name, udt_name AS type, is_nullable = 'YES' AS nullable,
      column_default AS expression FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = ${table}`.execute(db)
  ).rows;
}
export function serial() {
  return randomUUID().replaceAll('-', '');
}
export async function person(db: Connection, appId = `pay-${randomUUID()}`) {
  const userId = randomUUID();
  await insert(db, 'users', {
    id: userId,
    app_id: appId,
    nickname: 'pay fixture',
    avatar: '',
    invite_code: randomUUID(),
    attr_code: randomUUID(),
    level: 'L1',
    status: 'normal',
    register_method: 'phone',
  });
  return { app_id: appId, user_id: userId };
}
export type Person = Awaited<ReturnType<typeof person>>;
export function order(p: Person, changes: Row = {}): Row {
  return {
    id: randomUUID(),
    ...p,
    biz_type: 'fixture_purchase',
    biz_ref: randomUUID(),
    pay_channel: 'wechat_pay',
    amount_fen: 100n,
    status: 'PENDING',
    out_trade_no: serial(),
    expire_at: LATER,
    updated_at: AT,
    ...changes,
  };
}
export function anomaly(appId: unknown, changes: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: appId,
    pay_channel: 'wechat_pay',
    channel_trade_no: serial(),
    amount_fen: 100n,
    evidence: { source: 'fixture' },
    status: 'open',
    ...changes,
  };
}
export function refund(parent: Row, changes: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: parent['app_id'],
    target_type: 'pay_order',
    target_id: parent['id'],
    idempotency_key: randomUUID(),
    out_refund_no: serial(),
    amount_fen: 10n,
    reason_code: 'USER_REQUEST',
    status: 'PROCESSING',
    operator: 'fixture:operator',
    ...changes,
  };
}
export function notification(parent: Row, changes: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: parent['app_id'],
    pay_channel: parent['pay_channel'],
    notify_id: serial(),
    out_trade_no: parent['out_trade_no'],
    payload_cipher: Buffer.from('fixture-ciphertext'),
    verify_result: 'ok',
    received_at: AT,
    ...changes,
  };
}
export function attempt(parent: Row, changes: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: parent['app_id'],
    pay_order_id: parent['id'],
    pay_refund_id: null,
    kind: 'query',
    request: { fixture: true },
    response: { fixture: true },
    result: 'unknown',
    at: AT,
    ...changes,
  };
}
export function fulfillment(parent: Row, changes: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: parent['app_id'],
    biz_type: parent['biz_type'],
    biz_ref: parent['biz_ref'],
    state: 'none',
    last_pay_order_id: parent['id'],
    ...changes,
  };
}
export async function scenario(db: Connection) {
  const p = await person(db);
  const o = order(p);
  await insert(db, 'pay_orders', o);
  const a = anomaly(p.app_id, { pay_order_id: o['id'] });
  await insert(db, 'pay_anomalies', a);
  const r = refund(o);
  await insert(db, 'pay_refunds', r);
  return { p, o, a, r };
}
