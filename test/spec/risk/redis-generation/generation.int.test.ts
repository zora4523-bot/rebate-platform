// R-04 option A against a real Redis (task B1-02zi, 9.3): the generation key's creation, refusal
// period, FLUSHDB, concurrent creation, worker renewal and the switched-off gate. The key name is
// the implementation's choice: the key is the one key of the `risk` namespace that is not a nonce.
// This file runs in a Redis database of its own (kit.ts DB_INDEX), FLUSHDB'd before and after
// every test.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  RequestCheck,
  RequestCheckInput,
} from '../../../../apps/api/src/modules/platform/http/request-checks.ts';
import {
  createRedisHandle,
  RedisUnavailableError,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import {
  createRedisGenerationGate,
  createRedisGenerationRenewal,
  createRequestSignatureVerifier,
  createSignatureCheck,
  type RedisGenerationGate,
} from '../../../../apps/api/src/modules/risk/index.ts';
import { DEVICE, SECRET, dependencies, httpFixture, inject, rejected } from '../signature/kit.ts';
import {
  DB_INDEX,
  GENERATION_TTL_MS,
  REFUSAL_MS,
  RENEW_INTERVAL_MS,
  acquire,
  apiRequire,
  databaseUrl,
  instantOf,
  keys,
  memoryLogger,
  nonce,
  redisConnection,
  replay,
  signed,
  silentLogger,
  type RawRedis,
  type Server,
} from './kit.ts';

let server: Server | undefined;
beforeAll(async () => {
  server = await acquire();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

interface Generation {
  key: string;
  value: string;
  createdAt: number;
  pttl: number;
}

interface Fixture {
  raw: RawRedis;
  handles: RedisHandle[];
  deps: ReturnType<typeof dependencies>;
  clock: FixedClock;
  log: ReturnType<typeof memoryLogger>;
  gate(options?: { handle?: number; clock?: FixedClock; enabled?: boolean }): RedisGenerationGate;
  check(
    generation: RedisGenerationGate,
    options?: { handle?: number; clock?: FixedClock },
  ): RequestCheck;
  generationKeys(): Promise<string[]>;
  generation(): Promise<Generation>;
  nonceStored(value: string): Promise<boolean>;
}

async function withRedis(run: (f: Fixture) => Promise<void>): Promise<void> {
  expect(server).toBeDefined();
  const url = databaseUrl(server!.url);
  const { Redis } = apiRequire('ioredis') as {
    Redis: new (url: string, options: object) => RawRedis;
  };
  const raw = new Redis(url, { db: DB_INDEX, maxRetriesPerRequest: 0, retryStrategy: () => null });
  const handles: RedisHandle[] = [];
  let selected = false;
  try {
    // An explicit SELECT on this one connection (no reconnects): FLUSHDB never reaches database 0.
    expect(await raw.call('SELECT', DB_INDEX)).toBe('OK');
    selected = true;
    await raw.call('FLUSHDB');
    for (let i = 0; i < 2; i++) {
      const handle = await createRedisHandle(redisConnection(url), { logger: silentLogger() });
      expect(handle).not.toBeNull();
      handles.push(handle!);
    }
    const deps = dependencies();
    const log = memoryLogger();
    const generationKeys = async () =>
      (await keys(raw, 'risk:*')).filter((key) => !key.startsWith('risk:nonce:'));
    // Built inside each test, never in a hook: the skeleton throws NotImplemented per case.
    await run({
      raw,
      handles,
      deps,
      clock: deps.clock,
      log,
      gate: (options = {}) =>
        createRedisGenerationGate({
          redis: handles[options.handle ?? 0]!,
          clock: options.clock ?? deps.clock,
          logger: log.logger,
          enabled: options.enabled ?? true,
        }),
      check: (generation, options = {}) =>
        createSignatureCheck({
          devices: deps.devices,
          clock: options.clock ?? deps.clock,
          redis: handles[options.handle ?? 0]!,
          generation,
        }),
      generationKeys,
      async generation() {
        const found = await generationKeys();
        expect(found, 'exactly one generation key in the risk namespace').toHaveLength(1);
        const key = found[0]!;
        const value = await raw.call('GET', key);
        const pttl = Number(await raw.call('PTTL', key));
        return { key, value: value as string, createdAt: instantOf(value), pttl };
      },
      nonceStored: async (value) =>
        (await raw.call('EXISTS', `risk:nonce:couli:${DEVICE}:${value}`)) === 1,
    });
  } finally {
    try {
      await Promise.all(handles.map((handle) => handle.close()));
      if (selected) await raw.call('FLUSHDB');
    } finally {
      raw.disconnect();
    }
  }
}

/**
 * Refused by the generation gate: rejected, nothing verified, and not one of stage ①'s client
 * refusals (10401 / 10402): the global filter answers it 50001 (the HTTP case below).
 */
async function refused(
  run: (request: RequestCheckInput) => Promise<unknown>,
  request: RequestCheckInput,
): Promise<void> {
  const outcome = await run(request).then(
    () => 'passed',
    (error: unknown) => error,
  );
  expect(outcome, 'the signed request is refused').toBeInstanceOf(Error);
  expect([10401, 10402]).not.toContain((outcome as { code?: unknown }).code);
  expect((outcome as { statusCode?: unknown }).statusCode ?? 500).toBe(500);
  expect(request.verifiedDevice).toBeUndefined();
}

function expectFullTtl(generation: Generation): void {
  expect(generation.pttl).toBeGreaterThan(GENERATION_TTL_MS - 10_000);
  expect(generation.pttl).toBeLessThanOrEqual(GENERATION_TTL_MS);
}

it('[R-04][BR-ID-09] 启用时代次键缺失：签名请求被拒、nonce 未登记，代次键建立（值为当前时刻，TTL 30×60 秒）；拒绝期内仍拒；过了创建时刻 + NONCE_TTL_SECONDS 放行并登记 nonce，重放仍 10401', async () => {
  await withRedis(async (f) => {
    const gate = f.gate();
    const check = f.check(gate);
    const t0 = f.clock.now().getTime();
    const first = signed(f.clock, nonce(1));
    await refused(check, first);
    expect(await f.nonceStored(nonce(1))).toBe(false);
    const created = await f.generation();
    expect(created.createdAt).toBe(t0);
    expectFullTtl(created);

    f.clock.advanceMs(REFUSAL_MS - 1);
    await refused(check, signed(f.clock, nonce(2)));
    expect(await f.nonceStored(nonce(2))).toBe(false);
    // The clipboard path's verifier (B1-02zc) is refused by the same gate.
    const verify = createRequestSignatureVerifier({
      devices: f.deps.devices,
      clock: f.clock,
      redis: f.handles[0]!,
      generation: gate,
    });
    await refused(verify, signed(f.clock, nonce(3)));
    expect(await f.nonceStored(nonce(3))).toBe(false);
    expect((await f.generation()).value).toBe(created.value);

    // 9.2 #6: entering the period is one warn line, flat fields, nothing personal.
    const warns = f.log.warns();
    expect(warns).toHaveLength(1);
    for (const line of warns) {
      expect(
        Object.values(line).every((value) => value === null || typeof value !== 'object'),
      ).toBe(true);
    }
    const text = f.log.lines.join('\n');
    for (const secret of [DEVICE, SECRET, nonce(1), String(first.headers['x-sign'])]) {
      expect(text).not.toContain(secret);
    }

    f.clock.advanceMs(2);
    const later = signed(f.clock, nonce(4));
    await check(later);
    expect(later.verifiedDevice).toEqual({ deviceId: DEVICE, appId: 'couli' });
    expect(await f.nonceStored(nonce(4))).toBe(true);
    await expect(check(replay(later))).rejects.toMatchObject({ code: 10401 });
    const clipboard = signed(f.clock, nonce(5));
    await expect(verify(clipboard)).resolves.toEqual({ deviceId: DEVICE, appId: 'couli' });
    expect(await f.nonceStored(nonce(5))).toBe(true);
    expect((await f.generation()).value).toBe(created.value);
    expect(f.log.warns()).toHaveLength(1);
  });
});

it('[R-04] 拒绝期内的签名请求经全局错误过滤器答 50001：处理器不执行、nonce 不登记', async () => {
  await withRedis(async (f) => {
    const gate = f.gate();
    const http = await httpFixture({
      deps: Object.assign(f.deps, { redis: f.handles[0]!, generation: gate }),
    });
    try {
      const body = await rejected(await inject(http.server, signed(f.clock, nonce(1))), 50001);
      expect(body).not.toHaveProperty('reached');
      expect(await f.nonceStored(nonce(1))).toBe(false);
      expect(await f.generationKeys()).toHaveLength(1);
      f.clock.advanceMs(REFUSAL_MS + 1);
      const response = await inject(http.server, signed(f.clock, nonce(2)));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ reached: true });
      expect(await f.nonceStored(nonce(2))).toBe(true);
    } finally {
      await http.server.close();
    }
  });
});

it('[R-04] 代次键存在且创建已早于拒绝期：照常验签并登记 nonce，重放仍 10401，代次值不变、不记 warn', async () => {
  await withRedis(async (f) => {
    const t0 = f.clock.now().getTime();
    await createRedisGenerationRenewal({ redis: f.handles[1]!, clock: f.clock }).renew();
    const seeded = await f.generation();
    expect(seeded.createdAt).toBe(t0);
    f.clock.advanceMs(REFUSAL_MS + 1);
    const check = f.check(f.gate());
    const request = signed(f.clock, nonce(1));
    await check(request);
    expect(request.verifiedDevice).toEqual({ deviceId: DEVICE, appId: 'couli' });
    expect(await f.nonceStored(nonce(1))).toBe(true);
    await expect(check(replay(request))).rejects.toMatchObject({ code: 10401 });
    expect((await f.generation()).value).toBe(seeded.value);
    expect(f.log.warns()).toHaveLength(0);
  });
});

it('[R-04][BR-ID-09] FLUSHDB 清空 Redis 后：下一次签名请求进入拒绝期，清空前登记过的 nonce 重放也不放行（重放窗口被关上）', async () => {
  await withRedis(async (f) => {
    const check = f.check(f.gate());
    await refused(check, signed(f.clock, nonce(1)));
    f.clock.advanceMs(REFUSAL_MS + 1);
    const before = signed(f.clock, nonce(2));
    await check(before);
    expect(await f.nonceStored(nonce(2))).toBe(true);
    await expect(check(replay(before))).rejects.toMatchObject({ code: 10401 });

    await f.raw.call('FLUSHDB');
    f.clock.advanceMs(1_000);
    const flushedAt = f.clock.now().getTime();
    // Its nonce is gone with the data: the replay must still not pass.
    await refused(check, replay(before));
    expect(await f.nonceStored(nonce(2))).toBe(false);
    const recreated = await f.generation();
    expect(recreated.createdAt).toBe(flushedAt);
    expectFullTtl(recreated);
    await refused(check, signed(f.clock, nonce(3)));
    expect(await f.nonceStored(nonce(3))).toBe(false);
    expect(f.log.warns()).toHaveLength(2);

    f.clock.advanceMs(REFUSAL_MS + 1);
    const after = signed(f.clock, nonce(4));
    await check(after);
    expect(await f.nonceStored(nonce(4))).toBe(true);
  });
});

it('[R-04] worker 停摆超过 TTL、代次键过期：按数据丢失处理，下一次签名请求重建代次键并进入拒绝期', async () => {
  await withRedis(async (f) => {
    const renewal = createRedisGenerationRenewal({ redis: f.handles[1]!, clock: f.clock });
    await renewal.renew();
    f.clock.advanceMs(REFUSAL_MS + 1);
    const check = f.check(f.gate());
    await check(signed(f.clock, nonce(1)));
    const { key } = await f.generation();
    // Shorten the test-owned key only, to exercise real expiry without waiting 30 minutes.
    await f.raw.call('PEXPIRE', key, 1);
    await expect.poll(() => f.raw.call('EXISTS', key), { timeout: 3000, interval: 20 }).toBe(0);
    f.clock.advanceMs(GENERATION_TTL_MS);
    const expiredAt = f.clock.now().getTime();
    await refused(check, signed(f.clock, nonce(2)));
    expect(await f.nonceStored(nonce(2))).toBe(false);
    const recreated = await f.generation();
    expect(recreated.createdAt).toBe(expiredAt);
    expectFullTtl(recreated);
  });
});

it('[R-04] 并发：两个进程同时建键，只有一个值生效，两边都按共享值推出同一拒绝期', async () => {
  await withRedis(async (f) => {
    const clockA = f.clock;
    const clockB = new FixedClock(new Date(clockA.now().getTime() + 5_000));
    const checkA = f.check(f.gate({ handle: 0, clock: clockA }), { handle: 0, clock: clockA });
    const checkB = f.check(f.gate({ handle: 1, clock: clockB }), { handle: 1, clock: clockB });
    const requests = Array.from({ length: 8 }, (_, index) =>
      signed(index % 2 === 0 ? clockA : clockB, nonce(100 + index)),
    );
    const results = await Promise.allSettled(
      requests.map((request, index) => (index % 2 === 0 ? checkA : checkB)(request)),
    );
    expect(results.map((result) => result.status)).toEqual(Array(8).fill('rejected'));
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(Error);
        expect([10401, 10402]).not.toContain((result.reason as { code?: unknown }).code);
      }
    }
    for (let index = 0; index < 8; index++) {
      expect(await f.nonceStored(nonce(100 + index))).toBe(false);
    }
    const winner = await f.generation();
    expect([clockA.now().getTime(), clockB.now().getTime()]).toContain(winner.createdAt);

    for (const clock of [clockA, clockB]) clock.set(new Date(winner.createdAt + REFUSAL_MS - 1));
    await refused(checkA, signed(clockA, nonce(201)));
    await refused(checkB, signed(clockB, nonce(202)));

    for (const clock of [clockA, clockB]) clock.set(new Date(winner.createdAt + REFUSAL_MS + 1));
    const a = signed(clockA, nonce(203));
    const b = signed(clockB, nonce(204));
    await checkA(a);
    await checkB(b);
    expect(a.verifiedDevice).toEqual({ deviceId: DEVICE, appId: 'couli' });
    expect(b.verifiedDevice).toEqual({ deviceId: DEVICE, appId: 'couli' });
    expect((await f.generation()).value).toBe(winner.value);
  });
});

it('[R-04] worker 续期：键缺失则建键（值为现在，TTL 30×60 秒）；键在则只刷新 TTL、值不变；续期建的键同样让签名请求进入拒绝期', async () => {
  await withRedis(async (f) => {
    const renewal = createRedisGenerationRenewal({ redis: f.handles[1]!, clock: f.clock });
    const t0 = f.clock.now().getTime();
    await renewal.renew();
    const first = await f.generation();
    expect(first.createdAt).toBe(t0);
    expectFullTtl(first);

    await f.raw.call('PEXPIRE', first.key, 5_000);
    f.clock.advanceMs(RENEW_INTERVAL_MS);
    await renewal.renew();
    const renewed = await f.generation();
    expect(renewed.key).toBe(first.key);
    expect(renewed.value).toBe(first.value);
    expectFullTtl(renewed);

    await f.raw.call('FLUSHDB');
    f.clock.advanceMs(RENEW_INTERVAL_MS);
    const t2 = f.clock.now().getTime();
    await renewal.renew();
    const recreated = await f.generation();
    expect(recreated.createdAt).toBe(t2);
    expectFullTtl(recreated);

    f.clock.advanceMs(1_000);
    const check = f.check(f.gate());
    await refused(check, signed(f.clock, nonce(1)));
    expect(await f.nonceStored(nonce(1))).toBe(false);
    expect((await f.generation()).value).toBe(recreated.value);
  });
});

it('[R-04] 关闭时（local / test 默认）：代次键缺失也不拒绝，不建代次键，nonce 照常登记，重放仍 10401', async () => {
  await withRedis(async (f) => {
    const check = f.check(f.gate({ enabled: false }));
    const request = signed(f.clock, nonce(1));
    await check(request);
    expect(request.verifiedDevice).toEqual({ deviceId: DEVICE, appId: 'couli' });
    expect(await f.nonceStored(nonce(1))).toBe(true);
    await expect(check(replay(request))).rejects.toMatchObject({ code: 10401 });
    expect(await f.generationKeys()).toEqual([]);
    expect(f.log.warns()).toHaveLength(0);
  });
});

it('[R-04][ADR-0001 §4.2 第17项] 启用时 Redis 不可用（句柄已关闭）：RedisUnavailableError（50001），不放行，不登记 nonce', async () => {
  await withRedis(async (f) => {
    const check = f.check(f.gate());
    await f.handles[0]!.close();
    const request = signed(f.clock, nonce(1));
    await expect(check(request)).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(request.verifiedDevice).toBeUndefined();
    expect(await f.nonceStored(nonce(1))).toBe(false);
    expect(await f.generationKeys()).toEqual([]);
  });
});
