// B1-22v rule tests (编排裁定 D10-446 ①; 规划/02 §6.2 治理层; 架构评估 R-04): helpers shared by
// the files of this directory. No Redis server here: the integration test acquires its own.
// Synthetic keys and names only; time is a FixedClock moved by the tests.
import { vi } from 'vitest';
import {
  createRedisQuotaLimiter,
  quotaShares,
  type FixedClock,
  type QuotaConfig,
  type QuotaPurpose,
  type RedisNamespace,
  type RedisQuotaLimiter,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';

/** The instant every FixedClock of these tests starts at. */
export const T0 = '2026-10-30T00:00:00.000Z';

/** Today's union bucket (app.module UNION_QUOTA + quotaShares('mvp')), kept by D10-446. */
export const UNION_CAPACITY = 100;
export const UNION_REFILL_PER_SECOND = 10;
export const MVP_SHARES = { online: 60, order_sync: 30, pool_refresh: 10, watch: 0 } as const;

/** Message of the warn line a refusal caused by Redis writes (redis-quota.ts contract). */
export const UNAVAILABLE = 'quota_redis_unavailable';
/** pino's numeric level of `warn`. */
export const WARN = 40;

export function config(overrides: Partial<QuotaConfig> = {}): QuotaConfig {
  return {
    bucketKey: 'union:taobao:synthetic-app',
    capacity: UNION_CAPACITY,
    refillPerSecond: UNION_REFILL_PER_SECOND,
    shares: quotaShares('mvp'),
    ...overrides,
  };
}

/** A namespace double whose `eval` answers with `reply()` (a fresh promise per call). */
export function fakeNamespace(reply: () => Promise<unknown>) {
  const evalScript = vi.fn<RedisNamespace['eval']>(() => reply());
  const get = vi.fn<RedisNamespace['get']>(async () => null);
  const set = vi.fn<RedisNamespace['set']>(async () => undefined);
  const namespace: RedisNamespace = { get, set, eval: evalScript };
  return { namespace, eval: evalScript, get, set };
}

/** The shared limiter of `config(overrides)` over `redis`. */
export function sharedLimiter(
  redis: RedisNamespace,
  clock: FixedClock,
  logger: RootLogger,
  overrides: Partial<QuotaConfig> = {},
): RedisQuotaLimiter {
  return createRedisQuotaLimiter(config(overrides), { redis, clock, logger });
}

interface AnyLimiter {
  tryAcquire(purpose: QuotaPurpose): boolean | Promise<boolean>;
}

/** How many tokens `purpose` yields right now (stops at the first refusal, at most `limit`). */
export async function drain(
  limiter: AnyLimiter,
  purpose: QuotaPurpose,
  limit: number = 1000,
): Promise<number> {
  let taken = 0;
  while (taken < limit && (await limiter.tryAcquire(purpose))) taken += 1;
  return taken;
}

export interface LogLine {
  readonly level: number;
  readonly msg: string;
  readonly [field: string]: unknown;
}

export function parsed(lines: readonly string[]): LogLine[] {
  return lines.map((line) => JSON.parse(line) as LogLine);
}

/** The warn lines of refusals caused by Redis. */
export function unavailableWarnings(lines: readonly string[]): LogLine[] {
  return parsed(lines).filter((line) => line.msg === UNAVAILABLE);
}

/** True when every field of the line is a flat value (no nested object, no array). */
export function flat(line: LogLine): boolean {
  return Object.values(line).every(
    (value) =>
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean',
  );
}
