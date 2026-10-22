import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';

// 经模块公开出口调用；动态 URL 避免 test 的 tsc 引入 Nest 装饰器依赖图。
export const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  readNotifyBeneficiaries: typeof import('../../../../apps/api/src/modules/commission/ports/notify-beneficiaries.ts').readNotifyBeneficiaries;
};
export const orders = (await import(
  new URL('../../../../apps/api/src/modules/orders/index.ts', import.meta.url).href
)) as {
  readNotifyOrderFacts: typeof import('../../../../apps/api/src/modules/orders/ports/notify-order-facts.ts').readNotifyOrderFacts;
  readNotifyClaimFacts: typeof import('../../../../apps/api/src/modules/orders/ports/notify-order-facts.ts').readNotifyClaimFacts;
};

export const AT = new Date('2026-10-20T03:04:05.000Z');
export const LONG_TITLE =
  '淘宝官方测试商品👨\u200D👩\u200D👧\u200D👦完整标题超过十二个字素，保留空格 与标点';

// 建库工厂由 *.int.test.ts 传入：依赖规则只允许 int 测试导入 @couli/db/testing。
export interface TestDatabaseHandle {
  urlFor(role: string): string;
  drop(): Promise<void>;
}

export function harness(createTestDatabase: () => Promise<TestDatabaseHandle>) {
  let database: TestDatabaseHandle | undefined;
  let db: Kysely<DB>;
  beforeAll(async () => {
    database = await createTestDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  }, 60_000);
  afterAll(async () => {
    try {
      if (db) await destroyDb(db);
    } finally {
      await database?.drop();
    }
  }, 60_000);
  return {
    get db() {
      return db;
    },
  };
}

export function newApp() {
  return `trade-read-${randomUUID()}`;
}

export async function seedUser(db: Kysely<DB>, app_id: string) {
  const id = randomUUID();
  await db
    .withSchema('app')
    .insertInto('users')
    .values({
      id,
      app_id,
      nickname: '合成用户',
      avatar: 'fixture',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      register_method: 'sms',
      status: 'normal',
      created_at: AT,
      updated_at: AT,
    })
    .execute();
  return id;
}

export async function seedKey(db: Kysely<DB>, app_id: string, platform = 'jd') {
  const order_id = randomUUID();
  const key = { app_id, order_id, platform, sub_order_id: `child-${order_id}`, attr_at: AT };
  await db.withSchema('app').insertInto('order_keys').values(key).execute();
  return key;
}

export async function seedOrder(
  db: Kysely<DB>,
  app_id: string,
  patch: Partial<Insertable<DB['orders']>> = {},
) {
  const key = await seedKey(db, app_id, patch.platform);
  return db
    .withSchema('app')
    .insertInto('orders')
    .values({
      ...key,
      raw_item_id: 'synthetic-product',
      user_id: null,
      buy_type: null,
      title: LONG_TITLE,
      platform_status: 'PAID',
      commission_version: 2,
      est_commission_fen: 1234n,
      base_fen: 850n,
      settle_commission_fen: 987n,
      row_version: 7,
      created_at: AT,
      updated_at: AT,
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function seedAmounts(
  db: Kysely<DB>,
  key: { app_id: string; order_id: string },
  version: number,
  people: readonly { user_id: string; role: string; amount_fen: bigint }[],
) {
  // 直接种已持久化事实，不调用分佣算法或当前规则；base 特意与订单预估不同。
  await db
    .withSchema('app')
    .insertInto('commission_split_amounts')
    .values(
      people.map((person) => ({
        app_id: key.app_id,
        order_id: key.order_id,
        commission_version: version,
        ...person,
        base_fen: 9007199254740999n,
        created_at: AT,
      })),
    )
    .execute();
}

export async function seedClaim(
  db: Kysely<DB>,
  app_id: string,
  patch: Partial<Insertable<DB['claims']>> = {},
) {
  const user_id = await seedUser(db, app_id);
  return db
    .withSchema('app')
    .insertInto('claims')
    .values({
      id: randomUUID(),
      app_id,
      user_id,
      platform: 'jd',
      order_no: `parent-${randomUUID()}`,
      order_no_type: 'parent',
      paid_date: '2026-10-20',
      status: 'manual_review',
      evidence_level: 'none',
      reason: '审核备注不是驳回原因码',
      row_version: 3,
      created_at: AT,
      updated_at: AT,
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function seedItem(
  db: Kysely<DB>,
  claim: { id: string; app_id: string; user_id: string; platform: string },
  patch: Partial<Insertable<DB['claim_items']>> = {},
) {
  // 只建 order_keys，刻意没有 orders 行：找回条目不能被订单 INNER JOIN 丢掉。
  const key = await seedKey(db, claim.app_id, claim.platform);
  return db
    .withSchema('app')
    .insertInto('claim_items')
    .values({
      id: randomUUID(),
      app_id: claim.app_id,
      claim_id: claim.id,
      applicant_user_id: claim.user_id,
      platform: key.platform,
      sub_order_id: key.sub_order_id,
      order_id: key.order_id,
      decision: null,
      reject_reason: null,
      decided_at: null,
      created_at: AT,
      updated_at: AT,
      row_version: 4,
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function state(db: Kysely<DB>, app_id: string) {
  const app = db.withSchema('app');
  return {
    orders: await app
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', app_id)
      .orderBy('order_id')
      .execute(),
    keys: await app
      .selectFrom('order_keys')
      .selectAll()
      .where('app_id', '=', app_id)
      .orderBy('order_id')
      .execute(),
    amounts: await app
      .selectFrom('commission_split_amounts')
      .selectAll()
      .where('app_id', '=', app_id)
      .orderBy('order_id')
      .orderBy('commission_version')
      .orderBy('role')
      .orderBy('user_id')
      .execute(),
    claims: await app
      .selectFrom('claims')
      .selectAll()
      .where('app_id', '=', app_id)
      .orderBy('id')
      .execute(),
    items: await app
      .selectFrom('claim_items')
      .selectAll()
      .where('app_id', '=', app_id)
      .orderBy('id')
      .execute(),
  };
}
