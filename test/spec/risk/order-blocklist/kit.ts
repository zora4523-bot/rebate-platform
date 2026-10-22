import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  createOrderBlocklistPorts as CreatePorts,
  OrderBlocklistQuery,
} from '../../../../apps/api/src/modules/risk/application/order-blocklist.ts';

// 与现有 risk 规则测试一致，经公共出口加载，避免 Nest 控制器进入纯 TS 测试项目。
const { createOrderBlocklistPorts } = (await import(
  new URL('../../../../apps/api/src/modules/risk/index.ts', import.meta.url).href
)) as { createOrderBlocklistPorts: typeof CreatePorts };

export const START = new Date('2026-10-10T15:00:00+08:00');
export const END = new Date('2026-10-31T00:00:00+08:00');
export const RULE = 'BLACKLIST_HIT';
export const INDEX = 'risk_hits_blacklist_once_key';
export const ABORT = new Error('caller rollback');

export function databaseFixture() {
  let database: { urlFor(role: string): string; drop(): Promise<void> };
  let db: Kysely<DB>;
  beforeAll(async () => {
    // 仅集成测试调用；数据库入口与凭据由现有 globalSetup 管理。
    const testing = (await import(
      new URL('../../../../packages/db/src/testing/index.ts', import.meta.url).href
    )) as { createTestDatabase(): Promise<typeof database> };
    database = await testing.createTestDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  }, 180_000);
  afterAll(async () => {
    try {
      if (db) await destroyDb(db);
    } finally {
      if (database) await database.drop();
    }
  });
  return () => db;
}

export function setup(db: Kysely<DB>) {
  const app = `order_block_${randomUUID()}`;
  const account = randomUUID();
  const clock = new FixedClock('2026-11-12T01:02:03.456Z');
  const key = randomBytes(32);
  const crypto = {
    blindIndex(value: string, context: string) {
      return createHmac('sha256', key).update(context).update('\0').update(value).digest('hex');
    },
  };
  // 在每个用例里调用骨架，不能在 beforeAll 中失败，也不把 NotImplemented 吞成预期错误。
  const ports = createOrderBlocklistPorts({ clock, crypto });
  const query: OrderBlocklistQuery = {
    app_id: app,
    platform: 'taobao',
    trade_parent_id: '3301987654123456',
    relation_id: 'R8',
    union_account_id: account,
    attr_at: START,
  };
  return {
    app,
    account,
    clock,
    crypto,
    ports,
    query,
    match: (overrides: Partial<OrderBlocklistQuery> = {}) =>
      db.transaction().execute((trx) => ports.match(trx, { ...query, ...overrides })),
    importInput: {
      app_id: app,
      platform: 'taobao',
      union_account_id: account,
      created_by: 'admin-fixture',
      imported_at: START,
      rows: [{ relation_id: 'R8', end_at: null }],
    },
    hitInput: {
      app_id: app,
      user_id: null,
      order_id: randomUUID(),
      dimension: 'channel' as const,
      value: 'R8',
      risk_action: 'manual_review' as const,
    },
  };
}
export type Fixture = ReturnType<typeof setup>;

export async function seedBlock(
  db: Kysely<DB> | Transaction<DB>,
  f: Fixture,
  overrides: Partial<{
    app_id: string;
    dimension: string;
    value: string;
    value_hmac: string | null;
    platform: string | null;
    union_account_id: string | null;
    start_at: Date | null;
    end_at: Date | null;
    expire_at: Date | null;
    status: string;
  }> = {},
) {
  const id = randomUUID();
  const suffix = overrides.dimension === 'order_no_suffix';
  await db
    .insertInto('blocklist')
    .values({
      id,
      app_id: f.app,
      dimension: 'channel',
      value: suffix ? '123456' : 'R8',
      value_hmac: null,
      platform: 'taobao',
      union_account_id: suffix ? null : f.account,
      start_at: suffix ? null : START,
      end_at: null,
      expire_at: null,
      status: 'active',
      violation_type: 'other',
      created_by: 'fixture-original-admin',
      reason: 'fixture reason',
      created_at: START,
      updated_at: START,
      ...overrides,
    })
    .execute();
  return id;
}

export async function state(db: Kysely<DB>, app: string) {
  return {
    blocks: await db
      .selectFrom('blocklist')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    hits: await db
      .selectFrom('risk_hits')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    rules: await db
      .selectFrom('risk_rules')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('rule_id')
      .execute(),
  };
}

export async function seedUser(db: Kysely<DB>, app: string) {
  const id = randomUUID();
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status)
    VALUES (${id}, ${app}, 'fixture', 'fixture', 'ABC234', 'ATTR0001', 'L1', 'sms', 'normal')`.execute(
    db,
  );
  return id;
}
