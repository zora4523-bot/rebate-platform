import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createSmsCodeService } from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';
import type { RedisHandle } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { acquireRedis, makeHmac, success, withFixture, type TestRedis } from './kit.ts';

let server: TestRedis | undefined;
beforeAll(async () => {
  server = await acquireRedis();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

it('[BR-ID-05] Redis 状态在独立服务实例间共享，密钥参与验证码校验，每个存活键有 TTL 且不存验证码明文', async () => {
  expect(server).toBeDefined();
  await withFixture(server!, async (f) => {
    const touched = new Map<string, { namespace: string; key: string }>();
    const handle = f.options.redis;
    const observed: RedisHandle = {
      namespace(name) {
        const ns = handle.namespace(name);
        const record = (key: string) => {
          touched.set(JSON.stringify([name, key]), { namespace: name, key });
        };
        return {
          get: (key) => ns.get(key),
          set: (key, value, ttl) => {
            record(key);
            return ns.set(key, value, ttl);
          },
          eval: (script, options) => {
            for (const key of options.keys) record(key);
            return ns.eval(script, options);
          },
        };
      },
      close: () => handle.close(),
      onApplicationShutdown: () => handle.onApplicationShutdown(),
    };
    const hmac = vi.fn(f.options.hmac);
    const service = createSmsCodeService({ ...f.options, redis: observed, hmac });
    success(await service.send({ app_id: 'couli', phone: f.number, purpose: 'login' }));
    const code = f.lastCode();
    expect(touched.size).toBeGreaterThan(0);
    let alive = 0;
    const stored: string[] = [];
    // Read only the keys handed to Redis by this test; no SCAN/FLUSH or assumed identity key format.
    for (const { namespace, key } of touched.values()) {
      const result = (await handle.namespace(namespace).eval(
        `
        local kind = redis.call('TYPE', KEYS[1]).ok
        if kind == 'none' then return {-2, ''} end
        local data
        if kind == 'string' then data = redis.call('GET', KEYS[1])
        elseif kind == 'hash' then data = redis.call('HGETALL', KEYS[1])
        elseif kind == 'zset' then data = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
        elseif kind == 'set' then data = redis.call('SMEMBERS', KEYS[1])
        elseif kind == 'list' then data = redis.call('LRANGE', KEYS[1], 0, -1)
        else data = redis.call('DUMP', KEYS[1]) end
        return {redis.call('PTTL', KEYS[1]), cjson.encode(data)}
      `,
        { keys: [key], args: [], ttlSeconds: 1 },
      )) as [number, string];
      if (result[0] === -2) continue;
      alive++;
      stored.push(`${key} ${result[1]}`);
      expect(result[0]).toBeGreaterThan(0);
      expect(`${key} ${result[1]}`).not.toMatch(new RegExp(`(?<!\\d)${code}(?!\\d)`));
    }
    expect(alive).toBeGreaterThan(0);
    const codeHashes = hmac.mock.results
      .filter(
        (result, index) => result.type === 'return' && hmac.mock.calls[index]![0].includes(code),
      )
      .map((result) => result.value as string);
    expect(codeHashes.length).toBeGreaterThan(0);
    expect(codeHashes.some((hash) => stored.some((value) => value.includes(hash)))).toBe(true);
    const request = { app_id: 'couli', phone: f.number, purpose: 'login' as const, code };
    const otherKey = createSmsCodeService({ ...f.options, hmac: makeHmac() });
    expect((await otherKey.verifyAndConsume(request)).code).not.toBe(0);
    const sameKey = createSmsCodeService(f.options);
    expect(await sameKey.verifyAndConsume(request)).toEqual({ code: 0 });
    expect(await service.verifyAndConsume(request)).toEqual({ code: 20003 });
  });
});
