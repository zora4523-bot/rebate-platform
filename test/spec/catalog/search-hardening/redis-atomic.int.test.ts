import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { acquireTestRedis, type TestRedis } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createAtomicSearchSessionStore,
  createRedisAtomicSessionStorage,
} from '../../../../apps/api/src/modules/catalog/infra/search-session-atomic.ts';
import { createRedisSearchSessionStore } from '../../../../apps/api/src/modules/catalog/infra/search-wiring.ts';
import type { SearchSession } from '../../../../apps/api/src/modules/catalog/search.ts';
import {
  createRedisHandle,
  type RedisHandle,
  type RedisNamespace,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { connection, memoryLogger } from '../../platform/redis/kit.ts';

interface RawRedis {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  disconnect(): void;
}

// Use the API's installed driver, as the platform Redis integration tests do.
const requireApi = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const { Redis } = requireApi('ioredis') as {
  Redis: new (url: string, options: object) => RawRedis;
};
let server: TestRedis;
beforeAll(async () => {
  server = await acquireTestRedis();
}, 180_000);
afterAll(async () => {
  await server?.stop();
}, 30_000);

async function withRedis(
  run: (redis: RedisNamespace, ttl: (key: string) => Promise<unknown>) => Promise<void>,
): Promise<void> {
  const namespace = `b105g_${randomUUID().replaceAll('-', '')}`;
  const raw = new Redis(server.url, { maxRetriesPerRequest: 0, retryStrategy: () => null });
  let handle: RedisHandle | null = null;
  try {
    handle = await createRedisHandle(connection('api', server.url), {
      logger: memoryLogger().logger,
    });
    expect(handle).not.toBeNull();
    await run(handle!.namespace(namespace), (key) => raw.call('TTL', `${namespace}:${key}`));
  } finally {
    try {
      await handle?.close();
    } finally {
      try {
        // Delete only this test's unique namespace; never flush a shared Redis service.
        let cursor = '0';
        do {
          const page = (await raw.call(
            'SCAN',
            cursor,
            'MATCH',
            `${namespace}:*`,
            'COUNT',
            100,
          )) as [string, string[]];
          cursor = page[0];
          if (page[1].length > 0) await raw.call('DEL', ...page[1]);
        } while (cursor !== '0');
      } finally {
        raw.disconnect();
      }
    }
  }
}

function session(appId = 'synthetic_app'): SearchSession {
  return {
    appId,
    requester: 'user:synthetic-user',
    query: { platform: 'taobao', q: 'synthetic', sort: 'relevance', has_coupon: false, limit: 1 },
    touchedAtMs: Date.parse('2026-10-06T10:00:00+08:00'),
    seen: ['tb:synthetic-origin'],
    seenPages: [1],
    dedupDisabled: false,
  };
}

it('[AC-B1-05g#26] 真实 Redis Lua 拒绝不匹配的旧值，包含误认为不存在的情形，原值不变', async () => {
  await withRedis(async (redis) => {
    const storage = createRedisAtomicSessionStorage(redis);
    const key = 'synthetic_app:session:synthetic-cas';
    const original = JSON.stringify(session());
    const replacement = JSON.stringify({ ...session(), seen: ['tb:synthetic-replacement'] });
    await redis.set(key, original, 1800);
    for (const expected of [JSON.stringify({ ...session(), seen: [] }), null]) {
      expect(await storage.compareAndSwap(key, expected, replacement, 1800)).toBe(false);
      expect(await storage.read(key)).toBe(original);
      expect(await redis.get(key)).toBe(original);
    }
    const absent = 'synthetic_app:session:synthetic-absent';
    expect(await storage.compareAndSwap(absent, original, replacement, 1800)).toBe(false);
    expect(await redis.get(absent)).toBeNull();
  });
});

it('[AC-B1-05g#27] 真实 Redis Lua 在旧值匹配时创建或替换，并设置不超过 1800 秒的 TTL', async () => {
  await withRedis(async (redis, ttl) => {
    const storage = createRedisAtomicSessionStorage(redis);
    const key = 'synthetic_app:session:synthetic-cas';
    const original = JSON.stringify(session());
    const replacement = JSON.stringify({ ...session(), seen: ['tb:synthetic-next'] });
    expect(await storage.compareAndSwap(key, null, original, 1800)).toBe(true);
    expect(await redis.get(key)).toBe(original);
    expect(await ttl(key)).toBeGreaterThan(0);
    expect(await ttl(key)).toBeLessThanOrEqual(1800);
    expect(await storage.compareAndSwap(key, original, replacement, 1800)).toBe(true);
    expect(await storage.read(key)).toBe(replacement);
    expect(await redis.get(key)).toBe(replacement);
    expect(await ttl(key)).toBeGreaterThan(0);
    expect(await ttl(key)).toBeLessThanOrEqual(1800);
    // A snapshot that was valid before the update must now conflict.
    expect(await storage.compareAndSwap(key, original, original, 1800)).toBe(false);
    expect(await redis.get(key)).toBe(replacement);
  });
});

it.each([
  [
    '原子存储组合',
    (redis: RedisNamespace) =>
      createAtomicSearchSessionStore(createRedisAtomicSessionStorage(redis)),
  ],
  ['生产会话工厂', createRedisSearchSessionStore],
] as const)(
  '[AC-B1-05g#28] %s：两个实例先读同一快照再依次写入，真实 Redis 保留双方 seen 和最早页号',
  async (_name, createStore) => {
    await withRedis(async (redis) => {
      const a = createStore(redis);
      const b = createStore(redis);
      const appId = 'synthetic_app';
      const id = 'synthetic-session';
      await a.write(appId, id, session(), 1800);
      // Fixed interleaving: both reads finish before either write. No timers or scheduler race.
      const snapshotA = await a.read(appId, id);
      const snapshotB = await b.read(appId, id);
      expect(snapshotA).not.toBeNull();
      expect(snapshotB).toEqual(snapshotA);
      await a.write(
        appId,
        id,
        {
          ...snapshotA!,
          seen: [...snapshotA!.seen, 'tb:synthetic-a', 'tb:synthetic-shared'],
          seenPages: [1, 3, 3],
          touchedAtMs: snapshotA!.touchedAtMs + 200,
        },
        1800,
      );
      await b.write(
        appId,
        id,
        {
          ...snapshotB!,
          seen: [...snapshotB!.seen, 'tb:synthetic-b', 'tb:synthetic-shared'],
          seenPages: [1, 2, 2],
          touchedAtMs: snapshotB!.touchedAtMs + 100,
        },
        1800,
      );
      const merged = await a.read(appId, id);
      expect(merged).not.toBeNull();
      expect(merged!.seen).toHaveLength(4);
      expect(new Set(merged!.seen).size).toBe(4);
      expect(merged!.seen.map((key, index) => [key, merged!.seenPages?.[index]]).sort()).toEqual([
        ['tb:synthetic-a', 3],
        ['tb:synthetic-b', 2],
        ['tb:synthetic-origin', 1],
        ['tb:synthetic-shared', 2],
      ]);
      expect(merged!.touchedAtMs).toBe(snapshotA!.touchedAtMs + 200);
      expect(await b.read(appId, id)).toEqual(merged);
    });
  },
);

it('[AC-B1-05g#29] 真实 Redis 中不同 app 的同名会话读写互不影响', async () => {
  await withRedis(async (redis) => {
    const a = createAtomicSearchSessionStore(createRedisAtomicSessionStorage(redis));
    const b = createAtomicSearchSessionStore(createRedisAtomicSessionStorage(redis));
    const id = 'synthetic-same-session';
    const first = session('synthetic_app_a');
    const second = { ...session('synthetic_app_b'), seen: ['tb:synthetic-other'], seenPages: [7] };
    await a.write(first.appId, id, first, 1800);
    expect(await b.read(second.appId, id)).toBeNull();
    await b.write(second.appId, id, second, 1800);
    expect(await a.read(first.appId, id)).toEqual(first);
    expect(await a.read(second.appId, id)).toEqual(second);
    await a.write(
      first.appId,
      id,
      {
        ...first,
        seen: [...first.seen, 'tb:synthetic-a-next'],
        seenPages: [1, 2],
      },
      1800,
    );
    expect((await b.read(first.appId, id))?.seen).toEqual([
      'tb:synthetic-origin',
      'tb:synthetic-a-next',
    ]);
    expect(await b.read(second.appId, id)).toEqual(second);
  });
});
