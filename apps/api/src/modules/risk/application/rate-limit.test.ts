// Unit tests of stage ⑬'s thresholds, bucket call and outage alerts (B1-03e §10). Redis is a
// scripted RedisHandle (no connection): these tests pin the arguments handed to the bucket script
// and how its replies and failures are read; the script itself runs against a real Redis in the
// rule tests (test/spec/risk/rate-limit/).
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  RedisUnavailableError,
  createRootLogger,
  type RedisHandle,
  type RedisScriptOptions,
} from '../../platform/index.ts';
import {
  RATE_LIMIT_KEY_CONTEXT,
  createRateLimitService,
  createRateLimitThresholdReader,
  type RateLimitConfigReader,
  type RateLimitRequest,
  type RateLimitThresholdReader,
} from './rate-limit.ts';

const APP = 'couli';
const UID = '019a0000-0000-7000-8000-0000000000a1';
const DEVICE = '019a0000-0000-7000-8000-0000000000d1';
const IP = '192.0.2.10';

function config(values: Record<string, unknown>): RateLimitConfigReader {
  return {
    configValue: async (_app, key) =>
      Object.hasOwn(values, key) ? { value: values[key], version: 1 } : null,
  };
}

function request(overrides: Partial<RateLimitRequest> = {}): RateLimitRequest {
  return {
    entry: 'api',
    app_id: APP,
    operationId: 'searchProducts',
    client_ip: IP,
    principal: { uid: UID, device_id: DEVICE, app_id: APP, sid: 's', scp: 'full' },
    ...overrides,
  };
}

interface Call {
  script: string;
  options: RedisScriptOptions;
}

function scriptedRedis(reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  const namespaces: string[] = [];
  const handle: RedisHandle = {
    namespace(name) {
      namespaces.push(name);
      return {
        get: () => Promise.reject(new Error('unused')),
        set: () => Promise.reject(new Error('unused')),
        eval: async (script, options) => {
          const call = { script, options };
          calls.push(call);
          return reply(call);
        },
      };
    },
    close: async () => undefined,
    onApplicationShutdown: async () => undefined,
  };
  return { handle, calls, namespaces };
}

function setup(
  reply: (call: Call) => unknown,
  thresholds: RateLimitThresholdReader = createRateLimitThresholdReader(config({})),
) {
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { entry: 'api', appEnv: 'test', level: 'info' },
    { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const clock = new FixedClock('2031-05-06T07:08:09.000Z');
  const redis = scriptedRedis(reply);
  const service = createRateLimitService({ clock, redis: redis.handle, thresholds, logger });
  return { service, clock, lines, ...redis };
}

it('[B1-03e §10] defaults: convert and search groups, no rule for an unnamed dimension', async () => {
  const reader = createRateLimitThresholdReader(config({}));
  expect(await reader.groupFor(APP, 'openLink')).toBe('convert');
  expect(await reader.groupFor(APP, 'convertLink')).toBe('convert');
  expect(await reader.groupFor(APP, 'searchProducts')).toBe('search');
  expect(await reader.groupFor(APP, 'sendSmsCode')).toBeNull();
  expect(await reader.rules(APP, 'convert', 'user')).toEqual([
    { limit: 30, window_sec: 60 },
    { limit: 500, window_sec: 86_400 },
  ]);
  expect(await reader.rules(APP, 'search', 'ip')).toEqual([{ limit: 120, window_sec: 60 }]);
  expect(await reader.rules(APP, 'search', 'device')).toEqual([]);
});

it('[B1-03e §10] a configured group replaces its defaults; a JSON text value is parsed', async () => {
  const reader = createRateLimitThresholdReader(
    config({ 'rate_limit.search': JSON.stringify({ device: [{ limit: 3, window_sec: 10 }] }) }),
  );
  expect(await reader.rules(APP, 'search', 'device')).toEqual([{ limit: 3, window_sec: 10 }]);
  expect(await reader.rules(APP, 'search', 'user')).toEqual([]);
});

for (const [name, value] of [
  ['zero limit', { user: [{ limit: 0, window_sec: 60 }] }],
  ['fractional limit', { user: [{ limit: 1.5, window_sec: 60 }] }],
  ['window above 31 days', { user: [{ limit: 1, window_sec: 2_678_401 }] }],
  ['dimension not a list', { user: { limit: 1, window_sec: 60 } }],
  ['array value', [{ limit: 1, window_sec: 60 }]],
] as const) {
  it(`[B1-03e §10] a malformed group (${name}) falls back to the defaults`, async () => {
    const reader = createRateLimitThresholdReader(config({ 'rate_limit.search': value }));
    expect(await reader.rules(APP, 'search', 'user')).toEqual([{ limit: 60, window_sec: 60 }]);
  });
}

it('[B1-03e §10] ops: merged over the defaults, null removes, an invalid group discards the value', async () => {
  const merged = createRateLimitThresholdReader(
    config({ 'rate_limit.ops': { listArticles: 'reading', openLink: null } }),
  );
  expect(await merged.groupFor(APP, 'listArticles')).toBe('reading');
  expect(await merged.groupFor(APP, 'openLink')).toBeNull();
  expect(await merged.groupFor(APP, 'convertLink')).toBe('convert');
  const invalid = createRateLimitThresholdReader(
    config({ 'rate_limit.ops': { listArticles: 'Bad Group', openLink: null } }),
  );
  expect(await invalid.groupFor(APP, 'listArticles')).toBeNull();
  expect(await invalid.groupFor(APP, 'openLink')).toBe('convert');
  // `ops` is the mapping key itself, never a group.
  expect(await merged.rules(APP, 'ops', 'user')).toEqual([]);
});

it('[B1-03e §10] one script call for every bucket: hashed identities, window keys, integer units', async () => {
  const { service, calls, namespaces } = setup(() => [1, 0]);
  expect(await service.check(request({ operationId: 'convertLink' }))).toEqual({ code: 0 });
  expect(namespaces).toEqual(['rl']);
  expect(calls).toHaveLength(1);
  const { keys, args, ttlSeconds } = calls[0]!.options;
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/^couli:convert:user:[0-9a-f]{32}:60$/);
  expect(keys[1]).toMatch(/^couli:convert:user:[0-9a-f]{32}:86400$/);
  expect(keys.join()).not.toContain(UID);
  expect(args).toEqual([
    String(Date.parse('2031-05-06T07:08:09.000Z')),
    '30',
    '60000',
    '120',
    '500',
    '86400000',
    '172800',
  ]);
  expect(ttlSeconds).toBe(172_800);
});

it('[B1-03e §10] dimensions: principal device first, else the verified device; missing ones skipped', async () => {
  const thresholds = createRateLimitThresholdReader(
    config({
      'rate_limit.search': {
        user: [{ limit: 1, window_sec: 60 }],
        device: [{ limit: 1, window_sec: 60 }],
        ip: [{ limit: 1, window_sec: 60 }],
      },
    }),
  );
  const { service, calls } = setup(() => [1, 0], thresholds);
  await service.check(request({ verifiedDevice: { deviceId: 'other', appId: APP } }));
  await service.check({
    entry: 'api',
    app_id: APP,
    operationId: 'searchProducts',
    verifiedDevice: { deviceId: DEVICE, appId: APP },
  });
  await service.check({ entry: 'api', app_id: APP, operationId: 'searchProducts' });
  const [full, anonymous] = calls.map((call) => call.options.keys);
  expect(full!.map((key) => key.split(':')[2])).toEqual(['user', 'device', 'ip']);
  expect(anonymous).toEqual([full![1]]);
  // No identity at all: no bucket and no Redis call.
  expect(calls).toHaveLength(2);
});

it('[B1-03e §10] two rules with the same window share one key: the stricter one counts', async () => {
  const thresholds = createRateLimitThresholdReader(
    config({
      'rate_limit.search': {
        user: [
          { limit: 9, window_sec: 60 },
          { limit: 4, window_sec: 60 },
        ],
      },
    }),
  );
  const { service, calls } = setup(() => [1, 0], thresholds);
  await service.check(request());
  expect(calls[0]!.options.keys).toHaveLength(1);
  expect(calls[0]!.options.args.slice(1)).toEqual(['4', '60000', '120']);
});

it('[B1-03e §10] ungrouped operations and the admin entry never reach Redis', async () => {
  const { service, calls } = setup(() => [1, 0]);
  expect(await service.check(request({ operationId: 'getArticle' }))).toEqual({ code: 0 });
  expect(await service.check(request({ entry: 'admin' }))).toEqual({ code: 0 });
  expect(calls).toEqual([]);
});

for (const [waitMs, seconds] of [
  [1, 1],
  [1000, 1],
  [1001, 2],
  [28_740_000, 28_740],
] as const) {
  it(`[B1-03e §10] a refusal waiting ${String(waitMs)} ms answers Retry-After ${String(seconds)}`, async () => {
    const { service } = setup(() => [0, waitMs]);
    expect(await service.check(request())).toEqual({ code: 42901, retryAfterSec: seconds });
  });
}

it('[B1-03e §10] outage: refuse with 1 s, one error, a flat summary per minute, one recovery line', async () => {
  let broken = true;
  const { service, clock, lines } = setup(() => {
    if (broken) throw new RedisUnavailableError('command_timeout');
    return [1, 0];
  });
  const alerts = () => lines.filter((line) => String(line['msg']).startsWith('rate_limit_store_'));
  expect(await service.check(request())).toEqual({ code: 42901, retryAfterSec: 1 });
  await service.check(request({ operationId: 'openLink' }));
  clock.advanceMs(59_999);
  await service.check(request({ operationId: 'openLink' }));
  expect(alerts().map((line) => line['msg'])).toEqual(['rate_limit_store_unavailable']);
  expect(alerts()[0]).toMatchObject({ level: 50, reason: 'command_timeout' });
  clock.advanceMs(1);
  await service.check(request());
  const summary = alerts()[1]!;
  expect(summary).toMatchObject({
    level: 40,
    msg: 'rate_limit_store_unavailable_summary',
    operations: 'openLink=2,searchProducts=2',
    rejected: 4,
  });
  broken = false;
  expect(await service.check(request())).toEqual({ code: 0 });
  expect(await service.check(request())).toEqual({ code: 0 });
  expect(alerts().map((line) => line['msg'])).toEqual([
    'rate_limit_store_unavailable',
    'rate_limit_store_unavailable_summary',
    'rate_limit_store_recovered',
  ]);
  expect(alerts()[2]).toMatchObject({ level: 30 });
  const text = JSON.stringify(alerts());
  for (const secret of [UID, DEVICE, IP]) expect(text).not.toContain(secret);
  for (const line of alerts()) {
    expect(Object.values(line).every((value) => value === null || typeof value !== 'object')).toBe(
      true,
    );
  }
});

it('[B1-03e §10] an unexpected script reply or a closed handle is a store failure, never a pass', async () => {
  const odd = setup(() => 'OK');
  expect(await odd.service.check(request())).toEqual({ code: 42901, retryAfterSec: 1 });
  const closed = setup(() => [1, 0]);
  const failing: RedisHandle = {
    ...closed.handle,
    namespace: vi.fn(() => {
      throw new RedisUnavailableError('closed');
    }),
  };
  const service = createRateLimitService({
    clock: closed.clock,
    redis: failing,
    thresholds: createRateLimitThresholdReader(config({})),
    logger: createRootLogger({ entry: 'api', appEnv: 'test', level: 'silent' }),
  });
  expect(await service.check(request())).toEqual({ code: 42901, retryAfterSec: 1 });
});

it('[B1-03e §10] a failed configuration read uses the defaults and is not a store outage', async () => {
  const thresholds = createRateLimitThresholdReader({
    configValue: () => Promise.reject(new Error('configuration database unavailable')),
  });
  const { service, calls, lines } = setup(() => [1, 0], thresholds);
  expect(await service.check(request())).toEqual({ code: 0 });
  expect(calls[0]!.options.keys.map((key) => key.split(':')[2])).toEqual(['user', 'ip']);
  expect(lines.some((line) => String(line['msg']).startsWith('rate_limit_store_'))).toBe(false);
});

it('[B1-03e §11] with field crypto the identity part of a key is its keyed blind index', async () => {
  const contexts: string[] = [];
  const crypto = {
    blindIndex(value: string, context: string) {
      contexts.push(context);
      return createHash('sha256').update(`secret:${context}:${value}`).digest('hex');
    },
  };
  const redis = scriptedRedis(() => [1, 0]);
  const service = createRateLimitService({
    clock: new FixedClock('2031-05-06T07:08:09.000Z'),
    redis: redis.handle,
    thresholds: createRateLimitThresholdReader(config({})),
    logger: createRootLogger({ entry: 'api', appEnv: 'test', level: 'silent' }),
    crypto,
  });
  expect(await service.check(request())).toEqual({ code: 0 });
  const unkeyed = createHash('sha256').update(IP).digest('hex').slice(0, 32);
  const keyed = crypto.blindIndex(IP, RATE_LIMIT_KEY_CONTEXT).slice(0, 32);
  const keys = redis.calls[0]!.options.keys;
  expect(keys).toContain(`couli:search:ip:${keyed}:60`);
  expect(keys.join()).not.toContain(unkeyed);
  expect(new Set(contexts)).toEqual(new Set([RATE_LIMIT_KEY_CONTEXT]));
});

it('[B1-03e §11] a key that cannot be derived refuses (42901, Retry-After 1) without a script call', async () => {
  const lines: Record<string, unknown>[] = [];
  const redis = scriptedRedis(() => [1, 0]);
  const service = createRateLimitService({
    clock: new FixedClock('2031-05-06T07:08:09.000Z'),
    redis: redis.handle,
    thresholds: createRateLimitThresholdReader(config({})),
    logger: createRootLogger(
      { entry: 'api', appEnv: 'test', level: 'info' },
      { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
    ),
    crypto: {
      blindIndex: () => {
        throw new Error('invalid_key');
      },
    },
  });
  expect(await service.check(request())).toEqual({ code: 42901, retryAfterSec: 1 });
  expect(redis.calls).toEqual([]);
  expect(lines.map((line) => line['msg'])).toEqual(['rate_limit_key_unavailable']);
  expect(JSON.stringify(lines)).not.toContain(IP);
});
