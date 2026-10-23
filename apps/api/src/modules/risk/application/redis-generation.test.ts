// Unit tests of the Redis generation gate and renewal (R-04, B1-02zi) over a scripted namespace:
// the arguments sent to Redis, the reply handling, the refusal period and the renewal timer. The
// Lua scripts themselves run against a real Redis in test/spec/risk/redis-generation/.
import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  RedisUnavailableError,
  createRootLogger,
  type RedisHandle,
  type RedisScriptOptions,
} from '../../platform/index.ts';
import { NONCE_TTL_SECONDS } from '../domain/request-signature.ts';
import {
  REDIS_GENERATION_RENEW_INTERVAL_MS,
  REDIS_GENERATION_TTL_SECONDS,
  RedisGenerationRefusalError,
  armRedisGeneration,
  createRedisGenerationGate,
  createRedisGenerationRenewal,
  isRedisGenerationArmed,
  processRedisGenerationGate,
  startRedisGenerationRenewal,
  type RedisGenerationSchedule,
} from './redis-generation.ts';

const T0 = '2026-10-23T08:00:00Z';

function harness(reply: (options: RedisScriptOptions) => unknown) {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const evalFn = vi.fn(async (_script: string, options: RedisScriptOptions) => reply(options));
  const namespace = vi.fn(() => ({ get: vi.fn(), set: vi.fn(), eval: evalFn }));
  const redis = { namespace } as unknown as Pick<RedisHandle, 'namespace'>;
  const clock = new FixedClock(T0);
  const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, evalFn, namespace, redis, clock, logs };
}

it('[R-04] the generation TTL is 30 renewal intervals of 60 seconds', () => {
  expect(REDIS_GENERATION_RENEW_INTERVAL_MS).toBe(60_000);
  expect(REDIS_GENERATION_TTL_SECONDS).toBe(1_800);
});

it('[R-04] armRedisGeneration switches the process on for staging / prod only (with the entry logger)', () => {
  const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
  const clock = new FixedClock(T0);
  try {
    expect(armRedisGeneration('prod', logger)).toBe(true);
    expect(isRedisGenerationArmed()).toBe(true);
    expect(processRedisGenerationGate(undefined, clock)?.reserveNonce).toEqual(
      expect.any(Function),
    );
    expect(armRedisGeneration('local', logger)).toBe(false);
    expect(isRedisGenerationArmed()).toBe(false);
    expect(processRedisGenerationGate(undefined, clock)).toBeUndefined();
    expect(armRedisGeneration('staging', logger)).toBe(true);
    expect(armRedisGeneration('prod')).toBe(false);
    expect(armRedisGeneration('test', logger)).toBe(false);
  } finally {
    armRedisGeneration('test');
  }
  expect(isRedisGenerationArmed()).toBe(false);
});

it('[R-04] reserveNonce: one script with both keys; refused in the period (warn on creation, no nonce), reserved or replay after it', async () => {
  const created = Date.parse(T0);
  let reply: unknown = [1, String(created), 0];
  const h = harness(() => reply);
  const gate = createRedisGenerationGate({
    redis: h.redis,
    clock: h.clock,
    logger: h.logger,
    enabled: true,
  });
  await expect(gate.reserveNonce!('nonce:couli:d:n')).rejects.toBeInstanceOf(
    RedisGenerationRefusalError,
  );
  expect(h.evalFn).toHaveBeenCalledTimes(1);
  expect(h.evalFn.mock.calls[0]![1]).toEqual({
    keys: ['generation', 'nonce:couli:d:n'],
    args: [String(created), String(REDIS_GENERATION_TTL_SECONDS), String(NONCE_TTL_SECONDS * 1000)],
    ttlSeconds: NONCE_TTL_SECONDS,
  });
  expect(h.logs().filter((line) => line['level'] === 40)).toHaveLength(1);
  reply = [0, String(created), 0];
  await expect(gate.reserveNonce!('nonce:couli:d:n')).rejects.toBeInstanceOf(
    RedisGenerationRefusalError,
  );
  expect(h.logs().filter((line) => line['level'] === 40)).toHaveLength(1);
  h.clock.advanceMs(NONCE_TTL_SECONDS * 1000);
  reply = [0, String(created), 1];
  await expect(gate.reserveNonce!('nonce:couli:d:n')).resolves.toBe(true);
  reply = [0, String(created), 2];
  await expect(gate.reserveNonce!('nonce:couli:d:n')).resolves.toBe(false);
  // Redis and the process must agree on the period; anything else fails closed.
  for (const bad of [[0, String(created), 0], [0, String(created), 3], [0, 'x', 1], null, 'OK']) {
    reply = bad;
    await expect(gate.reserveNonce!('nonce:couli:d:n')).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
  }
});

it('[R-04] the gate creating the key sends now and the TTL, refuses, and logs one flat warn line', async () => {
  const h = harness((options) => [1, options.args[0]]);
  const gate = createRedisGenerationGate({
    redis: h.redis,
    clock: h.clock,
    logger: h.logger,
    enabled: true,
  });
  await expect(gate.admit()).rejects.toBeInstanceOf(RedisGenerationRefusalError);
  expect(h.namespace).toHaveBeenCalledWith('risk');
  const options = h.evalFn.mock.calls[0]![1];
  expect(options).toEqual({
    keys: ['generation'],
    args: [String(Date.parse(T0))],
    ttlSeconds: REDIS_GENERATION_TTL_SECONDS,
  });
  const warns = h.logs().filter((line) => line['level'] === 40);
  expect(warns).toHaveLength(1);
  expect(warns[0]).toMatchObject({
    msg: 'redis_generation_refusal_started',
    generation_created_at: Date.parse(T0),
    refusal_ends_at: Date.parse(T0) + NONCE_TTL_SECONDS * 1000,
  });
});

it('[R-04] an existing key: refused without a warn inside the period, admitted from its end on', async () => {
  const created = Date.parse(T0);
  const h = harness(() => [0, String(created)]);
  const gate = createRedisGenerationGate({
    redis: h.redis,
    clock: h.clock,
    logger: h.logger,
    enabled: true,
  });
  h.clock.advanceMs(NONCE_TTL_SECONDS * 1000 - 1);
  await expect(gate.admit()).rejects.toBeInstanceOf(RedisGenerationRefusalError);
  h.clock.advanceMs(1);
  await expect(gate.admit()).resolves.toBeUndefined();
  expect(h.logs().filter((line) => line['level'] === 40)).toHaveLength(0);
});

it('[R-04] an unexpected reply or value fails closed with RedisUnavailableError', async () => {
  for (const reply of [null, 'OK', [2, '1'], [0, 'not-an-instant'], [1], [0, null]]) {
    const h = harness(() => reply);
    const gate = createRedisGenerationGate({
      redis: h.redis,
      clock: h.clock,
      logger: h.logger,
      enabled: true,
    });
    await expect(gate.admit()).rejects.toBeInstanceOf(RedisUnavailableError);
  }
});

it('[R-04] enabled without Redis refuses; disabled never touches Redis', async () => {
  const h = harness(() => [1, '0']);
  const closed = createRedisGenerationGate({ clock: h.clock, logger: h.logger, enabled: true });
  await expect(closed.admit()).rejects.toThrow(/no Redis/);
  const off = createRedisGenerationGate({
    redis: h.redis,
    clock: h.clock,
    logger: h.logger,
    enabled: false,
  });
  await expect(off.admit()).resolves.toBeUndefined();
  expect(h.namespace).not.toHaveBeenCalled();
  expect(h.evalFn).not.toHaveBeenCalled();
});

it('[R-04] renew sends now and the TTL; a recreated key logs a warn, a refreshed one nothing; other replies fail', async () => {
  let next: unknown = 0;
  const h = harness(() => next);
  const renewal = createRedisGenerationRenewal({
    redis: h.redis,
    clock: h.clock,
    logger: h.logger,
  });
  await renewal.renew();
  expect(h.evalFn.mock.calls[0]![1]).toEqual({
    keys: ['generation'],
    args: [String(Date.parse(T0))],
    ttlSeconds: REDIS_GENERATION_TTL_SECONDS,
  });
  expect(h.logs()).toHaveLength(0);
  next = 1;
  await renewal.renew();
  expect(h.logs()).toEqual([
    expect.objectContaining({ level: 40, msg: 'redis_generation_recreated', replaced: false }),
  ]);
  next = 'OK';
  await expect(renewal.renew()).rejects.toBeInstanceOf(RedisUnavailableError);
});

it('[R-04] the renewal timer renews at once and every 60 s, logs a failed renewal, and stops', async () => {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  let tick: (() => Promise<void>) | undefined;
  const cancel = vi.fn();
  const schedule = vi.fn<RedisGenerationSchedule>((callback) => {
    tick = callback;
    return { stop: cancel };
  });
  const renew = vi.fn(async () => {
    throw new RedisUnavailableError('command_failed');
  });
  const control = startRedisGenerationRenewal({ renewal: { renew }, logger, schedule });
  expect(schedule.mock.calls[0]![1]).toBe(60_000);
  expect(renew).toHaveBeenCalledTimes(1);
  await expect(tick!()).resolves.toBeUndefined();
  expect(renew).toHaveBeenCalledTimes(2);
  const warns = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(warns.at(-1)).toMatchObject({
    msg: 'redis_generation_renew_failed',
    error_name: 'RedisUnavailableError',
  });
  control.stop();
  control.stop();
  expect(cancel).toHaveBeenCalledTimes(1);
  await tick!();
  expect(renew).toHaveBeenCalledTimes(2);
});
