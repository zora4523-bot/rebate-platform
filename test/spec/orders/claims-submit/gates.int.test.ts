import { randomUUID } from 'node:crypto';
import { withHttp, answer } from './http-kit.ts';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, acquireTestRedis, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createRedisHandle,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { memoryLogger, redisConnection, type TestRedis } from '../../identity/sms-codes/kit.ts';
import { fixture, failure, PAID } from './kit.ts';

// Global setup supplies the migrated template; fixture and application use couli_app.
let database: TestDatabase | undefined;
let server: TestRedis | undefined;
let db: Kysely<DB>;
let redis: RedisHandle;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
  server = await acquireTestRedis();
  redis = (await createRedisHandle(redisConnection(server.url), {
    logger: memoryLogger().logger,
  }))!;
}, 180_000);
afterAll(async () => {
  try {
    await redis?.close();
  } finally {
    try {
      if (db) await destroyDb(db);
    } finally {
      try {
        await database?.drop();
      } finally {
        await server?.stop();
      }
    }
  }
}, 30_000);

it('[AC-B1-10b#45] 契约校验→版本门→幂等；低版本不计数、不占幂等键且拦已存重放', async () => {
  const f = await fixture(db, redis);
  const key = randomUUID();
  const payload = { platform: 'jd', order_no: 'missing', paid_date: PAID };
  await withHttp(
    { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
    async (send) => {
      await answer(await send(payload, { key }), 30201);
    },
  );
  await db
    .insertInto('app_versions')
    .values({
      id: randomUUID(),
      app_id: f.subject.app_id,
      platform: 'ios',
      channel: 'appstore',
      latest_version: '3.0.0',
      min_supported_version: '3.0.0',
      update_title: 'synthetic',
      update_notes: 'synthetic',
      store_url: 'https://example.invalid/app',
      default_store: 'appstore',
      store_listings: JSON.stringify([]),
    })
    .execute();
  await withHttp(
    { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
    async (send) => {
      const invalid = await send({ ...payload, order_no: '' });
      expect(invalid.json().code).toBe(20001);
      await answer(await send(payload, { key }), 10405);
      const fresh = randomUUID();
      await answer(await send(payload, { key: fresh }), 10405);
      expect(
        await db
          .selectFrom('idempotency_keys')
          .selectAll()
          .where('app_id', '=', f.subject.app_id)
          .where('key', '=', fresh)
          .execute(),
      ).toEqual([]);
      expect(await f.count()).toBe('1');
      expect(await f.claims()).toEqual([]);
    },
  );
}, 30_000);

it('[AC-B1-10b#46] Redis故障50001不存幂等结果；修复后同键可以正常处理', async () => {
  const f = await fixture(db, redis);
  const row = await f.seed();
  const key = randomUUID();
  const payload = { platform: 'jd', order_no: row.sub_order_id, paid_date: PAID };
  // No injected Redis is the deterministic unavailable dependency; other guards have real PG.
  await withHttp({ db, subject: f.subject, clock: f.clock }, async (send) => {
    expect((await send(payload, { key })).json().code).toBe(50001);
    expect(
      await db
        .selectFrom('idempotency_keys')
        .selectAll()
        .where('app_id', '=', f.subject.app_id)
        .where('key', '=', key)
        .execute(),
    ).toEqual([]);
    expect(await f.claims()).toEqual([]);
  });
  await withHttp(
    { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
    async (send) => {
      await answer(await send(payload, { key }), 0);
      expect(await f.claims()).toHaveLength(1);
      expect(await f.count()).toBeNull();
    },
  );
}, 30_000);

it('[AC-B1-10b#47] HTTP风险30203带reason、日上限30203无data，均不加次数', async () => {
  const f = await fixture(db, redis);
  for (let i = 0; i < 5; i++) await f.history(await f.seed());
  await f.setCount(10);
  await withHttp(
    { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
    async (send) => {
      const payload = { platform: 'jd', order_no: 'missing', paid_date: PAID };
      await answer(await send(payload), 30203, { reason: 'RISK_BLOCKED' });
      expect(await f.count()).toBe('10');
      await f.setCount(9);
      await answer(await send(payload), 30203);
      expect(await f.count()).toBe('9');
    },
  );
}, 30_000);

it('[AC-B1-10b#48] 五次成功后+08午夜创建额度清零，前一日记录保持可见', async () => {
  const f = await fixture(db, redis);
  f.clock.set('2028-01-15T15:59:59.999Z');
  for (let i = 0; i < 5; i++) await f.history(await f.seed());
  failure(await f.submit('missing'), 30203);
  f.clock.set('2028-01-15T16:00:00Z');
  const row = await f.seed();
  await f.accepted(row.sub_order_id, [row]);
  expect(await f.claims()).toHaveLength(6);
  expect(await f.count(f.subject, '20280116')).toBeNull();
});
