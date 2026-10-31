// B1-22v (编排裁定 D10-446 ①; 规划/02 §6.2 治理层; 架构评估 R-04): the union quota bucket shared
// by every process. Today each entry builds its own createMemoryQuotaLimiter, so the real
// upstream quota is multiplied by the number of processes. This limiter keeps the bucket in Redis
// instead: every process that passes the same namespace and the same bucket key takes from one
// bucket. The rule tests in test/spec/union/shared-quota/** import this file through
// platform/index.ts; the names, signatures and the semantics written here are the contract.
//
// createRedisQuotaLimiter(config, deps)
// - Validates `config` exactly as createMemoryQuotaLimiter does (same constraints, same
//   `GovernanceError('invalid_policy')`, thrown synchronously) before anything else. Building the
//   limiter sends nothing to Redis and arms no timer.
// - Same semantics as createMemoryQuotaLimiter (./index.ts "Quota details"): one bucket per
//   purpose; capacity floor(capacity × share / 100) whole tokens; starts full; refills
//   continuously at refillPerSecond × share / 100 tokens per second, never above its capacity;
//   `tryAcquire` takes one whole token; `online` takes from `pool_refresh` when its own bucket has
//   no whole token; no other purpose borrows. The arithmetic is exact (whole tokens, no floating
//   point drift): any sequence of calls at whole-millisecond instants gets exactly the answers the
//   memory limiter gives for the same sequence.
// - Shared: the state lives only in Redis, in `deps.redis` (a namespace of the entry's REDIS
//   handle), under keys derived from `config.bucketKey`. Limiters of any process with the same
//   namespace name and bucket key share one bucket; different bucket keys never share. Nothing is
//   kept in the process (no local tokens, no cache of the bucket).
// - Atomic: each `tryAcquire` is exactly one `deps.redis.eval` (one script does the refill, the
//   decision, the borrowing and the take), so concurrent calls of any number of processes never
//   grant more than the bucket holds. Every key the script writes gets the handle's TTL
//   (ARGV[1]); the TTL is at least the time an empty bucket needs to refill to full, so an expired
//   key is always a full bucket.
// - Time: `deps.clock.now()` in whole milliseconds (the process CLOCK; the same wall-time base in
//   every process), passed to the script. A bucket's time never moves backwards: a process whose
//   clock is behind gets no refill from that and cannot rewind the bucket for the others.
// - Fail closed (R-04): when `eval` rejects (RedisUnavailableError, RedisClosedError, a
//   validation error, a script error, anything) or answers something that is not the script's
//   answer, `tryAcquire` resolves `false`: it never rejects, never grants, does not retry and never
//   falls back to an in-process bucket. It then logs one warn line `quota_redis_unavailable` on
//   `deps.logger` with flat fields only: `bucket_key`, `purpose` and `reason` (the
//   RedisUnavailableError's `reason`, `unexpected_reply` for an unusable answer, else `error`) —
//   never the URL, a credential, the error message, the error object or a stack.
//
// Governor (./index.ts, same task): `QuotaLimiter.tryAcquire` may now return a boolean (the memory
// limiter, test stubs) or a promise. The governor awaits it before the attempt; `false` or a
// rejection fails the call with `GovernanceError('quota_exceeded')` (never the limiter's own
// error): the operation is not invoked, nothing is recorded in the breaker, nothing is retried.
// The union governance layer (union/application/governed-adapter.ts, B1-04w gateUpstream), the
// order-sync governed adapter and the worker runtime only pass the limiter on, so their results
// stay those of the governor. createMemoryQuotaLimiter stays synchronous (it returns a boolean;
// test/spec/platform/http/quota.test.ts drains it synchronously).
//
// Wiring (app.module.ts, same task): every union quota limiter of every entry that builds governed
// union adapters (api: GovernedUnion; stream: the Agent's business ports; worker: the order-sync
// quota port) is built with createRedisQuotaLimiter called through platform/index.ts (the wiring
// rule test spies on that export), once per registered platform endpoint when the governed
// adapters are assembled, with config { bucketKey: endpoint.quotaKey, capacity: 100,
// refillPerSecond: 10, shares: quotaShares('mvp') } (one constant in app.module; TODO CAP-TB-12,
// CAP-JD-12, CAP-PDD-12: only the numbers change after measurement), deps.redis = a namespace of
// the entry's REDIS handle, under one namespace name shared by every entry (each decision is one
// script in that namespace), deps.clock = the entry's CLOCK. With REDIS
// provided, createMemoryQuotaLimiter is never used for a union adapter. admin and payout build no
// governed union adapter (payout has no Redis). Note: OrdersModule.forWorker (orders.module.ts)
// does not inject REDIS today; the worker's quota port must reach the entry's handle another way.
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with the `.ts` extension, no NestJS, no `process.env`; logging only through
// `deps.logger`; time only from `deps.clock`.
import type { Clock } from '../clock/index.ts';
import type { RootLogger } from '../logging/index.ts';
import { RedisUnavailableError, type RedisNamespace } from '../redis/index.ts';
import {
  GovernanceError,
  type QuotaConfig,
  type QuotaLimiter,
  type QuotaPurpose,
} from './index.ts';

export interface RedisQuotaDeps {
  /** A namespace of the entry's REDIS handle; every process passes the same namespace name. */
  readonly redis: RedisNamespace;
  /** The process CLOCK: the shared bucket's time base. */
  readonly clock: Clock;
  /** Receives the `quota_redis_unavailable` warn lines. */
  readonly logger: RootLogger;
}

/** A limiter whose bucket lives in Redis; `tryAcquire` resolves, never rejects. */
export interface RedisQuotaLimiter extends QuotaLimiter {
  tryAcquire(purpose: QuotaPurpose): Promise<boolean>;
}

const PURPOSES: readonly QuotaPurpose[] = ['online', 'order_sync', 'pool_refresh', 'watch'];

/** Largest integer a Lua number (an IEEE double) holds exactly. */
const EXACT_LIMIT = 2n ** 53n;

/**
 * Seconds every written key outlives the time an empty sub-bucket needs to refill to full: a
 * margin for process clocks that differ a little from Redis' own expiry clock.
 */
const TTL_MARGIN_SECONDS = 60;

/**
 * One sub-bucket's state is `<origin ms>:<consumed>` (memory limiter: startedAt, consumed). The
 * rate is exact: every `period` ms add exactly `tokens` whole tokens (period / tokens is the rate
 * reduced to lowest terms), so the memory limiter's comparisons `elapsed × rate ≥ consumed` and
 * `capacity − consumed + floor(elapsed × rate) ≥ 1` become integer products. Before comparing,
 * whole periods are moved out of the origin (origin += m × period, consumed −= m × tokens), which
 * leaves every answer unchanged and keeps every product below 2^53, so Lua's doubles are exact.
 * A bucket's time never moves backwards (now = max(now, origin)). Writes only on a grant; every
 * written key expires after ARGV[1] seconds (≥ the full-refill time: an expired key is full).
 * ARGV: [1] ttl, [2] now ms, then capacity / tokens / period per key. Answers 1 or 0.
 */
const TAKE_SCRIPT = `local ttl = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local function quotient(a, b)
  local q = math.floor(a / b)
  if q * b > a then
    q = q - 1
  elseif (q + 1) * b <= a then
    q = q + 1
  end
  return q
end
local function take(key, base)
  local capacity = tonumber(ARGV[base])
  local tokens = tonumber(ARGV[base + 1])
  local period = tonumber(ARGV[base + 2])
  if capacity < 1 then
    return false
  end
  local origin = now
  local consumed = 0
  local state = redis.call('GET', key)
  if state then
    local o, c = string.match(state, '^(%d+):(%d+)$')
    if o then
      origin = tonumber(o)
      consumed = tonumber(c)
    end
  end
  local at = math.max(now, origin)
  local elapsed = at - origin
  local periods = quotient(elapsed, period)
  if periods * tokens >= consumed then
    origin = at
    consumed = 0
  else
    origin = origin + periods * period
    consumed = consumed - periods * tokens
    elapsed = elapsed - periods * period
    if elapsed * tokens >= consumed * period then
      origin = at
      consumed = 0
    elseif capacity - consumed + quotient(elapsed * tokens, period) < 1 then
      return false
    end
  end
  consumed = consumed + 1
  redis.call('SET', key, string.format('%.0f', origin) .. ':' .. string.format('%.0f', consumed), 'EX', ttl)
  return true
end
if take(KEYS[1], 3) then
  return 1
end
if KEYS[2] and take(KEYS[2], 6) then
  return 1
end
return 0`;

interface SubBucket {
  readonly key: string;
  /** capacity, tokens per period, period in ms (decimal strings for ARGV). */
  readonly args: readonly [string, string, string];
}

function integerInRange(value: number, min: number, max: number = Number.MAX_VALUE): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [a, b];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function invalid(bucketKey: unknown): GovernanceError {
  return new GovernanceError(
    'invalid_policy',
    typeof bucketKey === 'string' ? bucketKey : '',
    'Invalid quota policy',
  );
}

/** The shared Redis token bucket of `config.bucketKey` (see the contract above). */
export function createRedisQuotaLimiter(
  config: QuotaConfig,
  deps: RedisQuotaDeps,
): RedisQuotaLimiter {
  // The memory limiter's constraints, in the same order and with the same error.
  if (
    typeof config?.bucketKey !== 'string' ||
    config.bucketKey.trim() === '' ||
    !integerInRange(config.capacity, 1) ||
    !Number.isFinite(config.refillPerSecond) ||
    config.refillPerSecond <= 0 ||
    !PURPOSES.every((purpose) => integerInRange(config.shares?.[purpose], 0, 100)) ||
    PURPOSES.reduce((sum, purpose) => sum + config.shares[purpose], 0) !== 100
  ) {
    throw invalid(config?.bucketKey);
  }
  const bucketKey = config.bucketKey;
  // The memory limiter's exact rate: the shortest decimal form of refillPerSecond as a fraction.
  const [mantissa = '', exponent = '0'] = String(config.refillPerSecond).split('e');
  const [whole = '', fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  const numerator = BigInt(whole + fraction) * 10n ** BigInt(Math.max(0, -scale));
  // Tokens per millisecond of a sub-bucket = numerator × share / (10^scale × 100 × 1000).
  const perMs = 10n ** BigInt(Math.max(0, scale)) * 100n * 1000n;
  const buckets = new Map<QuotaPurpose, SubBucket>();
  let fullRefillSeconds = 1;
  for (const purpose of PURPOSES) {
    const share = BigInt(config.shares[purpose]);
    const capacity = (BigInt(config.capacity) * share) / 100n;
    let tokens = 1n;
    let period = 1n;
    if (capacity >= 1n) {
      const rate = numerator * share;
      const divisor = gcd(rate, perMs);
      tokens = rate / divisor;
      period = perMs / divisor;
      // Every product the script forms stays below 2^53 (exact in a Lua number); a rate whose
      // exact fraction is finer than that cannot be kept exactly and is refused like any other
      // policy the arithmetic cannot honour.
      if (
        period * tokens >= EXACT_LIMIT ||
        (capacity + tokens + 1n) * period >= EXACT_LIMIT ||
        (capacity + tokens + 1n) * tokens >= EXACT_LIMIT
      ) {
        throw invalid(bucketKey);
      }
      // Time an empty sub-bucket needs to refill to full: capacity × period / tokens ms.
      const refillMs = (capacity * period + tokens - 1n) / tokens;
      fullRefillSeconds = Math.max(fullRefillSeconds, Number((refillMs + 999n) / 1000n));
    }
    buckets.set(purpose, {
      key: `${bucketKey}:${purpose}`,
      args: [capacity.toString(), tokens.toString(), period.toString()],
    });
  }
  const ttlSeconds = fullRefillSeconds + TTL_MARGIN_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds)) throw invalid(bucketKey);
  const { redis, clock, logger } = deps;

  const refuse = (purpose: QuotaPurpose, reason: string): false => {
    logger.warn({ bucket_key: bucketKey, purpose, reason }, 'quota_redis_unavailable');
    return false;
  };

  return {
    bucketKey,
    async tryAcquire(purpose) {
      const own = buckets.get(purpose);
      if (own === undefined) return false;
      const borrowed = purpose === 'online' ? buckets.get('pool_refresh') : undefined;
      const parts = borrowed === undefined ? [own] : [own, borrowed];
      let reply: unknown;
      try {
        reply = await redis.eval(TAKE_SCRIPT, {
          keys: parts.map((part) => part.key),
          args: [String(Math.floor(clock.now().getTime())), ...parts.flatMap((part) => part.args)],
          ttlSeconds,
        });
      } catch (error) {
        return refuse(purpose, error instanceof RedisUnavailableError ? error.reason : 'error');
      }
      if (reply === 1) return true;
      if (reply === 0) return false;
      return refuse(purpose, 'unexpected_reply');
    },
  };
}
