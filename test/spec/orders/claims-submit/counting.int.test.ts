import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, acquireTestRedis, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createRedisHandle,
  RedisUnavailableError,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { memoryLogger, redisConnection, type TestRedis } from '../../identity/sms-codes/kit.ts';
import { fixture, failure } from './kit.ts';

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

it('[AC-B1-10b#26] 第10次即时失败返回自己的码，第11次RISK_BLOCKED，只打一条告警', async () => {
  const f = await fixture(db, redis);
  for (let i = 1; i <= 10; i++) {
    failure(await f.submit('missing-' + i), 30201);
    expect(await f.count()).toBe(String(i));
  }
  failure(await f.submit('missing-11'), 30203, { reason: 'RISK_BLOCKED' });
  expect(await f.count()).toBe('10');
  const burst = f.lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['msg'] === 'claim_fail_burst');
  expect(burst).toHaveLength(1);
  expect(burst[0]).toMatchObject({
    level: 40,
    app_id: f.subject.app_id,
    user_id: f.subject.user_id,
    outcome: expect.anything(),
  });
  for (const line of f.lines) {
    expect(line).not.toContain('missing-');
    for (const key of ['order_no', 'sub_order_id', 'paid_date']) {
      expect(JSON.parse(line)).not.toHaveProperty(key);
    }
  }
  const fields = Object.keys(burst[0]!).filter(
    (key) => !['level', 'time', 'pid', 'hostname', 'msg', 'entry', 'env', 'module'].includes(key),
  );
  expect(fields.sort()).toEqual(['app_id', 'outcome', 'user_id']);
});

it('[AC-B1-10b#27] TTL向上取整到+08午夜且至少1秒；午夜换键解除禁止', async () => {
  const expiries: number[] = [];
  const observed: RedisHandle = {
    ...redis,
    namespace(name) {
      const original = redis.namespace(name);
      return {
        ...original,
        eval(script, options) {
          expiries.push(options.ttlSeconds);
          return original.eval(script, options);
        },
      };
    },
  };
  const f = await fixture(db, observed);
  f.clock.set('2028-01-15T15:59:58.500Z');
  failure(await f.submit('missing'), 30201);
  expect(expiries).toEqual([2]);
  const ttl = await redis
    .namespace('claim')
    .eval('return redis.call("TTL", KEYS[1])', { keys: [f.counterKey()], args: [], ttlSeconds: 1 });
  expect(ttl).toBeGreaterThanOrEqual(1);
  expect(ttl).toBeLessThanOrEqual(2);
  await f.setCount(10);
  failure(await f.submit('missing'), 30203, { reason: 'RISK_BLOCKED' });
  f.clock.set('2028-01-15T16:00:00Z');
  failure(await f.submit('missing'), 30201);
  expect(await f.count(f.subject, '20280116')).toBe('1');
  expiries.length = 0;
  const other = await fixture(db, observed);
  other.clock.set('2028-01-15T15:59:59.999Z');
  failure(await other.submit('missing'), 30201);
  expect(expiries).toEqual([1]);
  const lastTtl = await redis.namespace('claim').eval('return redis.call("TTL", KEYS[1])', {
    keys: [other.counterKey()],
    args: [],
    ttlSeconds: 1,
  });
  expect(lastTtl).toBeGreaterThanOrEqual(0);
  expect(lastTtl).toBeLessThanOrEqual(1);
});

it.each(['get', 'write'] as const)(
  '[AC-B1-10b#28] Redis %s故障失败关闭50001，不建claim且原计数不变',
  async (operation) => {
    const f = await fixture(db, redis);
    await f.setCount(4);
    const broken: RedisHandle = {
      ...redis,
      namespace(name) {
        const original = redis.namespace(name);
        return {
          ...original,
          ...(operation === 'get'
            ? {
                get: async () => {
                  throw new RedisUnavailableError('command_failed');
                },
              }
            : {
                eval: async () => {
                  throw new RedisUnavailableError('command_failed');
                },
                set: async () => {
                  throw new RedisUnavailableError('command_failed');
                },
              }),
        };
      },
    };
    const row = await f.seed();
    // A read failure must also prevent an otherwise successful claim.
    failure(
      await f.submit(operation === 'get' ? row.sub_order_id : 'missing', {}, f.subject, {
        redis: broken,
      }),
      50001,
    );
    expect(await f.count()).toBe('4');
    expect(await f.claims()).toEqual([]);
    expect(await f.items()).toEqual([]);
  },
);

it('[AC-B1-10b#29] 并发12个不同子单受理只有5条，败者不计即时失败', async () => {
  const f = await fixture(db, redis);
  const rows = await Promise.all(Array.from({ length: 12 }, () => f.seed()));
  const answers = await Promise.all(rows.map((row) => f.submit(row.sub_order_id)));
  expect(answers.filter((r) => r.code === 0)).toHaveLength(5);
  expect(answers.filter((r) => r.code === 30203)).toHaveLength(7);
  expect(await f.claims()).toHaveLength(5);
  expect(await f.items()).toHaveLength(5);
  expect(await f.count()).toBeNull();
});

it('[AC-B1-10b#30] 并发同一子单只建一条，其他30205且按请求计数', async () => {
  const f = await fixture(db, redis);
  const row = await f.seed();
  const answers = await Promise.all(Array.from({ length: 6 }, () => f.submit(row.sub_order_id)));
  expect(answers.filter((r) => r.code === 0)).toHaveLength(1);
  expect(answers.filter((r) => r.code === 30205)).toHaveLength(5);
  expect(await f.claims()).toHaveLength(1);
  expect(await f.items()).toHaveLength(1);
  expect(await f.count()).toBe('5');
});

it('[AC-B1-10b#31] 并发即时失败在第10次截止，无丢计数且只记录一次burst', async () => {
  const f = await fixture(db, redis);
  await f.setCount(8);
  const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => f.submit('missing-' + i)));
  expect(answers.filter((r) => r.code === 30201)).toHaveLength(2);
  expect(answers.filter((r) => r.code === 30203)).toHaveLength(4);
  expect(await f.count()).toBe('10');
  expect(f.lines.filter((line) => line.includes('"msg":"claim_fail_burst"'))).toHaveLength(1);
});
