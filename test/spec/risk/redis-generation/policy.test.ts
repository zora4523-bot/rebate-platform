// R-04 option A without a Redis server: the APP_ENV switch, fail-closed on an unavailable Redis,
// the switched-off gate, and the worker's renewal schedule. Behaviour against a real Redis (SET NX,
// TTL, FLUSHDB, concurrency) is in generation.int.test.ts.
import { expect, it, vi } from 'vitest';
import { RedisUnavailableError } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import {
  createRedisGenerationGate,
  createRequestSignatureVerifier,
  createSignatureCheck,
  isRedisGenerationEnabled,
  startRedisGenerationRenewal,
  type RedisGenerationSchedule,
} from '../../../../apps/api/src/modules/risk/index.ts';
import { DEVICE, dependencies, httpFixture, inject, rejected } from '../signature/kit.ts';
import {
  RENEW_INTERVAL_MS,
  everyKey,
  nonce,
  notNonce,
  replay,
  signed,
  silentLogger,
  splitRedis,
} from './kit.ts';

it('[R-04] 代次识别只在 APP_ENV 为 staging / prod 时启用，local / test 关闭', () => {
  expect(isRedisGenerationEnabled('staging')).toBe(true);
  expect(isRedisGenerationEnabled('prod')).toBe(true);
  expect(isRedisGenerationEnabled('local')).toBe(false);
  expect(isRedisGenerationEnabled('test')).toBe(false);
});

for (const [name, failing] of [
  ['代次键读写失败（nonce 存储仍可用）', notNonce],
  ['整个 Redis 不可用', everyKey],
] as const) {
  it(`[R-04][BR-ID-09][ADR-0001 §4.2 第17项] 启用时${name}：签名请求以 RedisUnavailableError 拒绝（50001），nonce 不登记、不放行；坏签名与未知设备仍是 10401 / 10402`, async () => {
    const deps = dependencies();
    const split = splitRedis(failing);
    const gate = createRedisGenerationGate({
      redis: split.redis,
      clock: deps.clock,
      logger: silentLogger(),
      enabled: true,
    });
    const parts = {
      devices: deps.devices,
      clock: deps.clock,
      redis: split.redis,
      generation: gate,
    };
    const check = createSignatureCheck(parts);
    const request = signed(deps.clock, nonce(1));
    await expect(check(request)).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(request.verifiedDevice).toBeUndefined();
    expect(split.reserved.size).toBe(0);

    // The clipboard path (B1-02zc) verifies with the same rules and the same gate.
    const verify = createRequestSignatureVerifier(parts);
    await expect(verify(signed(deps.clock, nonce(2)))).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
    expect(split.reserved.size).toBe(0);

    // The gate sits right before the nonce reservation: the earlier checks keep their codes.
    const bad = signed(deps.clock, nonce(3));
    await expect(
      check({ ...bad, headers: { ...bad.headers, 'x-sign': '0'.repeat(64) } }),
    ).rejects.toMatchObject({ code: 10401 });
    await expect(
      check({
        ...bad,
        headers: { ...bad.headers, 'x-device-id': '019a0000-0000-7000-8000-0000000000ff' },
      }),
    ).rejects.toMatchObject({ code: 10402 });

    const http = await httpFixture({
      deps: Object.assign(deps, { redis: split.redis, generation: gate }),
    });
    try {
      const body = await rejected(await inject(http.server, signed(deps.clock, nonce(4))), 50001);
      expect(body).not.toHaveProperty('reached');
    } finally {
      await http.server.close();
    }
    expect(split.reserved.size).toBe(0);
  });
}

it('[R-04] 关闭时（local / test 默认）：不读写代次键，代次存储坏了也照常验签、登记 nonce、放行，重放仍 10401', async () => {
  const deps = dependencies();
  const split = splitRedis(notNonce);
  const gate = createRedisGenerationGate({
    redis: split.redis,
    clock: deps.clock,
    logger: silentLogger(),
    enabled: false,
  });
  const check = createSignatureCheck({
    devices: deps.devices,
    clock: deps.clock,
    redis: split.redis,
    generation: gate,
  });
  const request = signed(deps.clock, nonce(1));
  await check(request);
  expect(request.verifiedDevice).toEqual({ deviceId: DEVICE, appId: 'couli' });
  expect(split.reserved.size).toBe(1);
  await expect(check(replay(request))).rejects.toMatchObject({ code: 10401 });
  expect(split.reserved.size).toBe(1);

  const http = await httpFixture({
    deps: Object.assign(deps, { redis: split.redis, generation: gate }),
  });
  try {
    const response = await inject(http.server, signed(deps.clock, nonce(2)));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reached: true,
      verifiedDevice: { deviceId: DEVICE, appId: 'couli' },
    });
  } finally {
    await http.server.close();
  }
  expect(split.reserved.size).toBe(2);
  expect(split.touched.filter(notNonce)).toEqual([]);
});

it('[R-04] worker 每 60 秒续期一次：一次续期失败不让定时回调拒绝、下一次照常续期；stop 后取消定时器、已排队的回调不再续期', async () => {
  let tick: (() => Promise<void>) | undefined;
  const cancel = vi.fn();
  const schedule = vi.fn<RedisGenerationSchedule>((callback) => {
    tick = callback;
    return { stop: cancel };
  });
  let calls = 0;
  const renew = vi.fn(async () => {
    calls += 1;
    if (calls === 2) throw new RedisUnavailableError('command_failed');
  });
  const control = startRedisGenerationRenewal({
    renewal: { renew },
    logger: silentLogger(),
    schedule,
  });
  expect(schedule).toHaveBeenCalledTimes(1);
  expect(schedule.mock.calls[0]![1]).toBe(RENEW_INTERVAL_MS);
  expect(tick).toEqual(expect.any(Function));
  // Whether the start renews once at once is not specified; count the ticks' renewals only.
  const atStart = renew.mock.calls.length;
  expect(atStart).toBeLessThanOrEqual(1);
  for (let i = 0; i < 3; i++) await expect(tick!()).resolves.toBeUndefined();
  expect(renew.mock.calls.length - atStart).toBe(3);
  control.stop();
  expect(cancel).toHaveBeenCalledTimes(1);
  await expect(tick!()).resolves.toBeUndefined();
  expect(renew.mock.calls.length - atStart).toBe(3);
});
