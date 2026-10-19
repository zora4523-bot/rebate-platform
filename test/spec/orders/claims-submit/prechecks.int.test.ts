import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, acquireTestRedis, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createRedisHandle,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { memoryLogger, redisConnection, type TestRedis } from '../../identity/sms-codes/kit.ts';
import { fixture, failure, at } from './kit.ts';

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

it('[AC-B1-10b#1] AC-S1-26-TB③ 开关先于风控、上限和匹配，且不访问 Redis', async () => {
  const f = await fixture(db, redis);
  f.settings.set('claims.enabled', false);
  await f.setCount(10);
  for (let i = 0; i < 5; i++) await f.history(await f.seed());
  const unusable: RedisHandle = {
    ...redis,
    namespace() {
      throw new Error('Redis must not be touched');
    },
  };
  failure(await f.submit('missing', {}, f.subject, { redis: unusable }), 30206);
  expect(await f.count()).toBe('10');
  expect(await f.claims()).toHaveLength(5);
});

it('[AC-B1-10b#2] ①风险禁止优先于②五条上限；两种30203的data不同且不加失败', async () => {
  const f = await fixture(db, redis);
  for (let i = 0; i < 5; i++) await f.history(await f.seed());
  await f.setCount(10);
  failure(await f.submit('missing'), 30203, { reason: 'RISK_BLOCKED' });
  expect(await f.count()).toBe('10');
  await f.setCount(9);
  failure(await f.submit('missing'), 30203);
  expect(await f.count()).toBe('9');
});

it('[AC-B1-10b#3] 删去全部U+0020为空先回20001，不读失败次数、不建claim', async () => {
  const f = await fixture(db, redis);
  f.settings.set('claims.enabled', false);
  await f.setCount(10);
  failure(await f.submit('   '), 20001, { fields: ['order_no'] });
  expect(await f.count()).toBe('10');
  expect(await f.claims()).toEqual([]);
});

it.each(['missing', 'unavailable'] as const)(
  '[AC-B1-10b#4] claims.enabled %s按默认true继续匹配',
  async (mode) => {
    const f = await fixture(db, redis);
    if (mode === 'unavailable')
      f.config.configValue = async () => {
        throw new Error('config unavailable');
      };
    const row = await f.seed();
    await f.accepted(row.sub_order_id, [row]);
    expect(await f.count()).toBeNull();
  },
);

it('[AC-B1-10b#5] AC-S1-26-TB③ 第六次30203；今日计数含已终结，昨日前不计', async () => {
  const f = await fixture(db, redis);
  for (let i = 0; i < 4; i++)
    await f.history(await f.seed(), { status: 'rejected', evidence_level: 'none' });
  await f.history(await f.seed(), { created_at: at('2028-01-14T15:59:59.999Z') });
  const row = await f.seed();
  await f.accepted(row.sub_order_id, [row]);
  failure(await f.submit('missing'), 30203);
  expect(await f.count()).toBeNull();
});

it('[AC-B1-10b#6] 当日计数隔离app与用户，跨平台共用上限', async () => {
  const f = await fixture(db, redis);
  const other = await f.user();
  for (let i = 0; i < 5; i++) await f.history(await f.seed(), { user_id: other });
  await f.setCount(10, { ...f.subject, user_id: other });
  const foreign = await fixture(db, redis);
  await foreign.setCount(10);
  const row = await f.seed({ platform: 'taobao' });
  await f.accepted(row.sub_order_id, [row], { platform: 'taobao' });
  for (let i = 0; i < 4; i++) await f.history(await f.seed({ platform: 'pdd' }));
  failure(await f.submit('missing'), 30203);
  expect(await f.count()).toBeNull();
});

it('[AC-B1-10b#7] ③不存在30201只加一次；不产生claim或item', async () => {
  const f = await fixture(db, redis);
  failure(await f.submit('missing'), 30201);
  expect(await f.count()).toBe('1');
  expect(await f.claims()).toEqual([]);
  expect(await f.items()).toEqual([]);
});
