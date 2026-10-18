import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  NOW,
  CODE,
  withHttp,
  seed,
  client,
  answer,
  row,
  logs,
  callsFor,
  count,
  type Fixture,
} from './http-kit.ts';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let redis: Awaited<ReturnType<typeof acquireTestRedis>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  redis = await acquireTestRedis();
}, 180_000);
afterAll(async () => {
  try {
    await redis?.stop();
  } finally {
    try {
      if (db) await destroyDb(db);
    } finally {
      await database?.drop();
    }
  }
});
const http = (run: (f: Fixture) => Promise<void>) => withHttp(db, redis.url, run);

// Supplement #4 through the real AppModule and binder; no activity reader override.
for (const [platformStatus, rebateStatus] of [
  ['PAID', 'ESTIMATED'],
  ['INVALID', 'VOID'],
] as const) {
  it(`[AC-B1-11e#4] 真实订单读取器：已有 ${platformStatus}/${rebateStatus} 订单返回 30409，关系与日志零写入`, async () => {
    await http(async (f) => {
      await seed(f, CODE);
      const c = await client(f);
      const identity = {
        order_id: randomUUID(),
        app_id: c.appId,
        platform: 'taobao',
        sub_order_id: randomUUID(),
        attr_at: new Date(NOW),
      };
      await f.db.transaction().execute(async (trx) => {
        await trx.insertInto('order_keys').values(identity).execute();
        await trx
          .insertInto('orders')
          .values({
            ...identity,
            raw_item_id: 'backfill-assembly-fixture',
            user_id: c.uid,
            buy_type: 'self',
            platform_status: platformStatus,
            rebate_status: rebateStatus,
            created_at: new Date(NOW),
            updated_at: new Date(NOW),
          })
          .execute();
      });
      const before = await row(f, c.uid);
      answer(f, await c.post(), 30409);
      expect(await row(f, c.uid)).toEqual(before);
      expect(await logs(f, c.uid)).toEqual([]);
      expect(callsFor(f, c.uid)).toEqual([
        {
          transactional: true,
          command: {
            app_id: c.appId,
            user_id: c.uid,
            device_id: c.deviceId,
            channel: 'backfill',
            invite_code: CODE,
          },
        },
      ]);
    });
  });
}

// TODO(规划/11 §2.3): 真实找回申请行经 HTTP 返回 30409 的装配验证 — blocked on B1-10 找回申请表与读取器

for (const state of ['banned', 'appealing', 'frozen'] as const) {
  it(`[AC-B1-11e#14] 真实风控读取器：邀请人 ${state} 返回 30401 并计一次当日失败，关系与日志零写入`, async () => {
    await http(async (f) => {
      const parent = await seed(f, CODE);
      const c = await client(f);
      await f.db
        .insertInto('user_risk_state')
        .values({
          app_id: c.appId,
          user_id: parent,
          state,
          reason: 'backfill assembly fixture',
          reason_category: 'other',
          changed_by: 'fixture',
          changed_at: new Date(NOW),
          created_at: new Date(NOW),
          updated_at: new Date(NOW),
        })
        .execute();
      const before = await row(f, c.uid);
      expect(await count(f, c.uid)).toBeNull();
      const result = answer(f, await c.post(), 30401);
      expect(result.msg).toBe('邀请码无效');
      expect(await count(f, c.uid)).toBe('1');
      expect(await row(f, c.uid)).toEqual(before);
      expect(await logs(f, c.uid)).toEqual([]);
      expect(callsFor(f, c.uid)).toEqual([
        {
          transactional: true,
          command: {
            app_id: c.appId,
            user_id: c.uid,
            device_id: c.deviceId,
            channel: 'backfill',
            invite_code: CODE,
          },
        },
      ]);
    });
  });
}
