import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConnectionConfig } from '../../../../apps/api/src/modules/platform/db/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  createRedisHandle,
  RedisUnavailableError,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { createSignatureCheck } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  DEVICE,
  NONCE,
  NOW,
  SECRET,
  SMS,
  ROOT,
  apiRequire,
  dependencies,
  input,
  sign,
} from './kit.ts';

interface TestRedis {
  url: string;
  stop(): Promise<void>;
}
interface RawRedis {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  disconnect(): void;
}
let server: TestRedis | undefined;
beforeAll(async () => {
  const testing = (await import(new URL('packages/db/src/testing/index.ts', ROOT).href)) as Record<
    string,
    unknown
  >;
  if (typeof testing['acquireTestRedis'] === 'function')
    server = await (testing['acquireTestRedis'] as () => Promise<TestRedis>)();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

async function withRedis(
  run: (context: {
    handles: RedisHandle[];
    raw: RawRedis;
    device: string;
    key: string;
  }) => Promise<void>,
) {
  expect(server).toBeDefined();
  const { Redis } = apiRequire('ioredis') as {
    Redis: new (url: string, options: object) => RawRedis;
  };
  const raw = new Redis(server!.url, { maxRetriesPerRequest: 0, retryStrategy: () => null });
  const handles: RedisHandle[] = [];
  const device = randomUUID();
  const key = `risk:nonce:couli:${device}:${NONCE}`;
  try {
    for (let i = 0; i < 2; i++) {
      const handle = await createRedisHandle(
        loadConnectionConfig('api', {
          DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/rules',
          DATABASE_READ_URL: 'postgres://couli_readonly@127.0.0.1:1/rules',
          REDIS_URL: server!.url,
        }),
        {
          logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
        },
      );
      expect(handle).not.toBeNull();
      handles.push(handle!);
    }
    await run({ handles, raw, device, key });
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
    try {
      await raw.call('DEL', key, `risk:nonce:second:${device}:${NONCE}`);
    } finally {
      raw.disconnect();
    }
  }
}

it('[BR-ID-09] 跨两个独立Redis句柄并发重放只有一个成功；持久键含app/device/nonce和600秒TTL', async () => {
  expect(server).toBeDefined();
  await withRedis(async ({ handles, raw, device, key }) => {
    const deps = dependencies();
    deps.rows.delete(DEVICE);
    deps.rows.set(device, { deviceId: device, appId: 'couli', installSecret: SECRET });
    const checks = handles.map((redis) => createSignatureCheck({ ...deps, redis }));
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, (_, index) => {
        const request = input();
        return checks[index % 2]!({
          ...request,
          headers: { ...request.headers, 'x-device-id': device },
        });
      }),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failures = results.filter((result) => result.status === 'rejected');
    expect(failures).toHaveLength(23);
    for (const failure of failures) expect(failure.reason).toMatchObject({ code: 10401 });
    expect(await raw.call('GET', key)).not.toBeNull();
    expect(await raw.call('PTTL', key)).toBeGreaterThan(590_000);
    expect(await raw.call('PTTL', key)).toBeLessThanOrEqual(600_000);
  });
});

it('[BR-ID-09] 重放不延长TTL，Redis键过期后同nonce携新时间戳可再次通过', async () => {
  expect(server).toBeDefined();
  await withRedis(async ({ handles, raw, device, key }) => {
    const deps = dependencies();
    deps.rows.set(device, { deviceId: device, appId: 'couli', installSecret: SECRET });
    const check = createSignatureCheck({ ...deps, redis: handles[0]! });
    const original = input();
    const request = { ...original, headers: { ...original.headers, 'x-device-id': device } };
    await check(request);
    expect(await raw.call('PTTL', key)).toBeGreaterThan(590_000);
    // Shorten a test-owned key only, to exercise real expiry without sleeping ten minutes.
    await raw.call('PEXPIRE', key, 590_000);
    await expect(check(input({ headers: request.headers }))).rejects.toMatchObject({ code: 10401 });
    expect(await raw.call('PTTL', key)).toBeLessThanOrEqual(590_000);
    await raw.call('PEXPIRE', key, 1);
    await expect.poll(() => raw.call('EXISTS', key), { timeout: 3000, interval: 20 }).toBe(0);
    deps.clock.advanceMs(600_000);
    const timestamp = String(NOW + 600);
    const fresh = input({
      headers: {
        ...request.headers,
        'x-timestamp': timestamp,
        'x-sign': sign('POST', SMS, request.rawBody, timestamp, NONCE),
      },
    });
    await check(fresh);
    expect(fresh.verifiedDevice).toEqual({ deviceId: device, appId: 'couli' });
    expect(await raw.call('PTTL', key)).toBeGreaterThan(590_000);
  });
});

it('[BR-ID-09][BR-ID-01] nonce隔离使用设备行app_id，不使用伪造X-App-Id', async () => {
  expect(server).toBeDefined();
  await withRedis(async ({ handles, raw, device, key }) => {
    const deps = dependencies();
    deps.rows.set(device, { deviceId: device, appId: 'couli', installSecret: SECRET });
    const check = createSignatureCheck({ ...deps, redis: handles[0]! });
    const original = input();
    const request = {
      ...original,
      headers: { ...original.headers, 'x-device-id': device, 'x-app-id': 'second' },
    };
    await raw.call('SET', `risk:nonce:second:${device}:${NONCE}`, 'other-app', 'EX', 600);
    await check(request);
    expect(await raw.call('EXISTS', key)).toBe(1);
    expect(request.verifiedDevice).toEqual({ deviceId: device, appId: 'couli' });
    await expect(
      check(input({ headers: { ...request.headers, 'x-app-id': 'couli' } })),
    ).rejects.toMatchObject({ code: 10401 });
  });
});

it('[BR-ID-09][ADR-0001 §4.2 第17项] 已关闭Redis句柄不能放行，坏签名仍先返回10401', async () => {
  // Fail closed and propagate RedisUnavailableError to B1-01za's global error filter.
  expect(server).toBeDefined();
  await withRedis(async ({ handles, device }) => {
    const deps = dependencies();
    deps.rows.set(device, { deviceId: device, appId: 'couli', installSecret: SECRET });
    const check = createSignatureCheck({ ...deps, redis: handles[0]! });
    await handles[0]!.close();
    const original = input();
    const request = { ...original, headers: { ...original.headers, 'x-device-id': device } };
    await expect(check(request)).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(request.verifiedDevice).toBeUndefined();
    await expect(
      check({ ...request, headers: { ...request.headers, 'x-sign': '0'.repeat(64) } }),
    ).rejects.toMatchObject({ code: 10401 });
  });
});
