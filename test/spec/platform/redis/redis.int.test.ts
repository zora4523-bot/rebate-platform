// Only the orchestrator runs this file: one-shot Redis, never the local stack or production.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createRedisHandle,
  RedisClosedError,
  RedisUnavailableError,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { connection, failure, memoryLogger, serviceUrl } from './kit.ts';

interface TestRedis {
  url: string;
  source: 'env' | 'testcontainers';
  stop(): Promise<void>;
}
interface RawRedis {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
}
// The spec package has no direct ioredis dependency: use the exact driver installed for
// apps/api (B1-01x), rather than silently adding a second version or changing package.json.
const requireApi = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const { Redis } = requireApi('ioredis') as {
  Redis: new (url: string, options: object) => RawRedis;
};

async function acquire(): Promise<TestRedis> {
  // Existing module, guarded missing export: red must be AssertionError, never module-not-found.
  const testing = (await import(
    new URL('../../../../packages/db/src/testing/index.ts', import.meta.url).href
  )) as Record<string, unknown>;
  expect(typeof testing['acquireTestRedis']).toBe('function');
  return await (testing['acquireTestRedis'] as () => Promise<TestRedis>)();
}

// Share one service across this file's command tests; allow image pull time in the hook.
// The provisioning/stop test below acquires its own handle to check lifecycle independently.
let sharedServer: TestRedis | undefined;
beforeAll(async () => {
  const testing = (await import(
    new URL('../../../../packages/db/src/testing/index.ts', import.meta.url).href
  )) as Record<string, unknown>;
  const acquireShared = testing['acquireTestRedis'];
  // Leave undefined on the skeleton: each test fails its own assertion, not this hook.
  if (typeof acquireShared === 'function') {
    sharedServer = await (acquireShared as () => Promise<TestRedis>)();
  }
}, 180_000);
afterAll(async () => {
  await sharedServer?.stop();
}, 30_000);

async function withRedis(
  run: (context: {
    handle: NonNullable<Awaited<ReturnType<typeof createRedisHandle>>>;
    raw: RawRedis;
    namespace: string;
  }) => Promise<void>,
): Promise<void> {
  expect(sharedServer).toBeDefined();
  const server = sharedServer!;
  const raw = new Redis(server.url, { maxRetriesPerRequest: 0, retryStrategy: () => null });
  // 25 chars, 31 with _other: stay below 40; implementations must allow at least 64 (§10).
  const namespace = `t${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  let handle: Awaited<ReturnType<typeof createRedisHandle>> = null;
  try {
    handle = await createRedisHandle(connection('api', server.url), {
      logger: memoryLogger().logger,
    });
    expect(handle).not.toBeNull();
    await run({ handle: handle!, raw, namespace });
  } finally {
    try {
      await handle?.close();
    } finally {
      try {
        // SCAN + explicit DEL only inside this test's unique namespace; no FLUSHDB / FLUSHALL.
        let cursor = '0';
        do {
          const page = (await raw.call(
            'SCAN',
            cursor,
            'MATCH',
            `${namespace}*:*`,
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

it('[ADR-0001 §4.2 #17][B1-01y §9.3] 真实 SET 带秒 TTL；覆盖后 TTL 刷新；到期后消失', async () => {
  await withRedis(async ({ handle, raw, namespace }) => {
    const cache = handle.namespace(namespace);
    await cache.set('item', 'first', 60);
    expect(await raw.call('GET', `${namespace}:item`)).toBe('first');
    const ttl = await raw.call('PTTL', `${namespace}:item`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
    await cache.set('item', 'second', 1);
    expect(await cache.get('item')).toBe('second');
    expect(await raw.call('PTTL', `${namespace}:item`)).toBeLessThanOrEqual(1000);
    await expect.poll(() => cache.get('item'), { timeout: 5000, interval: 50 }).toBeNull();
  });
});

it('[ADR-0001 §4.2 #17][B1-01y §9.3] 不同命名空间的同名键隔离；Lua 两个写入键均有 TTL', async () => {
  await withRedis(async ({ handle, raw, namespace }) => {
    const first = handle.namespace(namespace);
    const second = handle.namespace(`${namespace}_other`);
    await second.set('one', 'untouched', 60);
    const script = [
      "redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[1])",
      "redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[1])",
      "return {redis.call('GET', KEYS[1]), redis.call('GET', KEYS[2])}",
    ].join('\n');
    expect(
      await first.eval(script, { keys: ['one', 'two'], args: ['a', 'b'], ttlSeconds: 15 }),
    ).toEqual(['a', 'b']);
    expect(await first.get('one')).toBe('a');
    expect(await second.get('one')).toBe('untouched');
    for (const key of ['one', 'two']) {
      const ttl = await raw.call('PTTL', `${namespace}:${key}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(15_000);
    }
  });
});

it('[ADR-0001 §4.2 #17][B1-01y §9.3] 真实 Redis 命令错误向上传递，不伪装成功；关闭后不能再用', async () => {
  await withRedis(async ({ handle, raw, namespace }) => {
    const cache = handle.namespace(namespace);
    await raw.call(
      'EVAL',
      "redis.call('LPUSH', KEYS[1], 'value'); return redis.call('EXPIRE', KEYS[1], 30)",
      1,
      `${namespace}:list`,
    );
    expect(await failure(() => cache.get('list'))).toBeInstanceOf(RedisUnavailableError);
    expect(
      await failure(() =>
        cache.eval("return redis.error_reply('test command failure')", {
          keys: [],
          args: [],
          ttlSeconds: 30,
        }),
      ),
    ).toBeInstanceOf(RedisUnavailableError);
    await handle.close();
    const error = await failure(() => cache.set('closed', 'value', 30));
    expect(error).toBeInstanceOf(RedisClosedError);
    expect(error).toBeInstanceOf(RedisUnavailableError);
    expect(await raw.call('EXISTS', `${namespace}:closed`)).toBe(0);
  });
});

it('[ADR-0001 §4.2 #17][B1-01y §9.3] 一次性 Redis 使用 db 0 和 noeviction；stop 不销毁共享环境服务', async () => {
  const server = await acquire();
  const fromEnv = process.env['TEST_REDIS_URL'];
  const raw = new Redis(server.url, { maxRetriesPerRequest: 0, retryStrategy: () => null });
  try {
    const url = serviceUrl(server.url);
    expect(url.pathname === '' || url.pathname === '/' || url.pathname === '/0').toBe(true);
    expect(await raw.call('CONFIG', 'GET', 'maxmemory-policy')).toEqual([
      'maxmemory-policy',
      'noeviction',
    ]);
    if (fromEnv !== undefined && fromEnv !== '') {
      expect(server.source).toBe('env');
      expect(server.url === fromEnv).toBe(true);
      await server.stop();
      expect(process.env['TEST_REDIS_URL'] === fromEnv).toBe(true);
      expect(await raw.call('PING')).toBe('PONG');
    } else {
      expect(server.source).toBe('testcontainers');
    }
  } finally {
    raw.disconnect();
    await server.stop();
  }
}, 180_000);
