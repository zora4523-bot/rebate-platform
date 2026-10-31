// B1-22v: the shared bucket fails closed (架构评估 R-04): when Redis cannot answer, a token is
// refused — never granted, never taken from an in-process bucket — and one warn line without the
// URL, a credential or the error text is written. Redis is a namespace double here; the real
// driver and server are in redis-limiter.int.test.ts.
import { expect, it } from 'vitest';
import {
  FixedClock,
  GovernanceError,
  RedisClosedError,
  RedisUnavailableError,
  RedisValidationError,
  createRedisQuotaLimiter,
  quotaShares,
  type QuotaConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { memoryLogger } from '../../platform/redis/kit.ts';
import {
  T0,
  WARN,
  config,
  fakeNamespace,
  flat,
  sharedLimiter,
  unavailableWarnings,
} from './kit.ts';

function outcome(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof GovernanceError) return error.code;
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  return 'returned';
}

it('[B1-22v] 建桶不碰 Redis；配置不合法与内存版一样一律 invalid_policy', () => {
  const { namespace, eval: script, get, set } = fakeNamespace(() => Promise.resolve(1));
  const deps = { redis: namespace, clock: new FixedClock(T0), logger: memoryLogger().logger };
  const shares = quotaShares('mvp');
  const bad: Record<string, QuotaConfig> = {
    sharesSumBelow: config({ shares: { ...shares, online: 59 } }),
    sharesSumAbove: config({ shares: { ...shares, watch: 1 } }),
    shareNegative: config({ shares: { ...shares, online: 70, watch: -10 } }),
    shareFraction: config({ shares: { ...shares, online: 59.5, watch: 0.5 } }),
    capacityZero: config({ capacity: 0 }),
    capacityFraction: config({ capacity: 10.5 }),
    refillZero: config({ refillPerSecond: 0 }),
    refillNaN: config({ refillPerSecond: Number.NaN }),
    refillInfinite: config({ refillPerSecond: Number.POSITIVE_INFINITY }),
    keyEmpty: config({ bucketKey: '' }),
  };
  expect({
    bad: Object.fromEntries(
      Object.entries(bad).map(([name, value]) => [
        name,
        outcome(() => createRedisQuotaLimiter(value, deps)),
      ]),
    ),
    good: outcome(() => createRedisQuotaLimiter(config(), deps)),
    fractionalRefill: outcome(() =>
      createRedisQuotaLimiter(config({ refillPerSecond: 0.5 }), deps),
    ),
  }).toEqual({
    bad: Object.fromEntries(Object.keys(bad).map((name) => [name, 'invalid_policy'])),
    good: 'returned',
    fractionalRefill: 'returned',
  });
  const limiter = createRedisQuotaLimiter(config({ bucketKey: 'union:jd:synthetic-app' }), deps);
  expect(limiter.bucketKey).toBe('union:jd:synthetic-app');
  expect({
    evals: script.mock.calls.length,
    gets: get.mock.calls.length,
    sets: set.mock.calls.length,
  }).toEqual({ evals: 0, gets: 0, sets: 0 });
});

it.each([
  ['connect_failed', () => new RedisUnavailableError('connect_failed', 'ECONNREFUSED')],
  ['connect_timeout', () => new RedisUnavailableError('connect_timeout')],
  ['command_timeout', () => new RedisUnavailableError('command_timeout')],
  ['script error reply', () => new RedisUnavailableError('command_failed', 'ERR')],
  ['handle closed', () => new RedisClosedError()],
  ['validation', () => new RedisValidationError('keys must be non-empty strings')],
  ['any other error', () => new Error('synthetic socket hang up')],
] as const)(
  '[B1-22v][R-04] Redis 不可用（%s）：tryAcquire 答 false 不抛错、每次恰发一条脚本不重试、不回落进程内桶',
  async (_name, failure) => {
    const { namespace, eval: script } = fakeNamespace(() => Promise.reject(failure()));
    const limiter = sharedLimiter(namespace, new FixedClock(T0), memoryLogger().logger);
    const answers: boolean[] = [];
    // 70 online calls: an in-process bucket of the same config would grant all of them (60 + 10).
    for (let call = 0; call < 70; call += 1) answers.push(await limiter.tryAcquire('online'));
    for (let call = 0; call < 5; call += 1) answers.push(await limiter.tryAcquire('order_sync'));
    expect({
      granted: answers.filter((answer) => answer).length,
      refused: answers.filter((answer) => !answer).length,
      scripts: script.mock.calls.length,
    }).toEqual({ granted: 0, refused: 75, scripts: 75 });
  },
);

it.each([
  ['a string the script never answers', () => Promise.resolve('synthetic-garbage-reply')],
  ['an object', () => Promise.resolve({ synthetic: true })],
] as const)(
  '[B1-22v][R-04] Redis 答非所问（%s）：按不可用处理，答 false 并记 unexpected_reply',
  async (_name, reply) => {
    const { namespace } = fakeNamespace(reply);
    const { logger, lines } = memoryLogger();
    const limiter = sharedLimiter(namespace, new FixedClock(T0), logger);
    const answer = await limiter.tryAcquire('online');
    expect({
      answer,
      warning: unavailableWarnings(lines).map((line) => ({
        level: line.level,
        bucket_key: line['bucket_key'],
        purpose: line['purpose'],
        reason: line['reason'],
      }))[0],
    }).toEqual({
      answer: false,
      warning: {
        level: WARN,
        bucket_key: 'union:taobao:synthetic-app',
        purpose: 'online',
        reason: 'unexpected_reply',
      },
    });
  },
);

it('[B1-22v][R-04] 被 Redis 拒绝时记 warn：平铺字段 bucket_key / purpose / reason，不带地址、凭据、错误原文与堆栈', async () => {
  const secret = 'synthetic-quota-secret';
  const known = fakeNamespace(() =>
    Promise.reject(new RedisUnavailableError('connect_failed', 'ECONNREFUSED')),
  );
  const leaky = fakeNamespace(() =>
    Promise.reject(
      Object.assign(new Error(`WRONGPASS ${secret} redis://:${secret}@10.0.0.1:6379/0`), {
        code: 'WRONGPASS',
      }),
    ),
  );
  const first = memoryLogger();
  const second = memoryLogger();
  const knownAnswer = await sharedLimiter(known.namespace, new FixedClock(T0), first.logger, {
    bucketKey: 'union:jd:synthetic-app',
  }).tryAcquire('online');
  const leakyAnswer = await sharedLimiter(
    leaky.namespace,
    new FixedClock(T0),
    second.logger,
  ).tryAcquire('order_sync');
  const knownWarnings = unavailableWarnings(first.lines);
  const leakyWarnings = unavailableWarnings(second.lines);
  const everything = [...first.lines, ...second.lines].join('\n');
  expect({
    answers: [knownAnswer, leakyAnswer],
    known: knownWarnings.map((line) => ({
      level: line.level,
      bucket_key: line['bucket_key'],
      purpose: line['purpose'],
      reason: line['reason'],
    }))[0],
    leaky: leakyWarnings.map((line) => ({
      level: line.level,
      bucket_key: line['bucket_key'],
      purpose: line['purpose'],
    }))[0],
    allFlat: [...knownWarnings, ...leakyWarnings].every(flat),
    secret: everything.includes(secret),
    url: everything.includes('redis://'),
    errorText: everything.includes('WRONGPASS'),
    stack: everything.includes('    at '),
  }).toEqual({
    answers: [false, false],
    known: {
      level: WARN,
      bucket_key: 'union:jd:synthetic-app',
      purpose: 'online',
      reason: 'connect_failed',
    },
    leaky: { level: WARN, bucket_key: 'union:taobao:synthetic-app', purpose: 'order_sync' },
    allFlat: true,
    secret: false,
    url: false,
    errorText: false,
    stack: false,
  });
});
