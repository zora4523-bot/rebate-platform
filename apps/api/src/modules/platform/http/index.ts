// Governance of calls to external dependencies (规划/02 §1 原则 4, §6.2 治理层, §14): every
// adapter (union platforms, model, payment channels, SMS, push, Jev) runs its upstream call
// through a `Governor`, which applies one timeout per attempt, retries only idempotent reads,
// trips a circuit breaker and takes a quota token. The rule tests
// in test/spec/platform/http/** import this file by path; names, signatures and the semantics
// written here are the contract.
//
// Values of 规划/02 §6.2 (returned by `unionPolicy`; other dependencies pass their own policy):
//   timeout   online call 3 000 ms; offline call (sync, refresh) 10 000 ms — per attempt
//   retry     idempotent reads only, at most 2 retries, exponential backoff; a write (转链, a
//             payout, anything not idempotent) is never retried here
//   breaker   within a 10 000 ms window: at least 20 attempts AND failure rate above 50 %
//             → open for 30 000 ms
//   quota     token bucket per configurable key, split by purpose: MVP online 60 %,
//             order sync 30 %, pool refresh 10 %; with P1 reminders pool refresh 5 %, watch 5 %;
//             when online runs out it takes pool-refresh tokens first (在线余量不足时先暂停
//             商品池刷新)
// Backoff before retry n (n = 1, 2, …) is min(maxDelayMs, baseDelayMs × 2^(n−1)); `unionPolicy`
// uses baseDelayMs 200 and maxDelayMs 2 000 (not fixed by 规划/02; a choice of this module).
//
// How one `call` runs. For every attempt, in this order:
//   1. breaker: when open, reject with `circuit_open`; the operation is not invoked, no token
//      is taken, nothing is recorded;
//   2. quota (only when a limiter and a purpose are given): take one token; when refused,
//      reject with `quota_exceeded`; nothing is recorded in the breaker;
//   3. invoke `operation(signal)`. When it has not settled after `timeoutMs`, abort `signal`
//      and fail the attempt with `timeout`;
//   4. classify the failure: `options.classify(error)` returns `failure` (the default for every
//      error, and always for `timeout`) or `rejected` (the dependency answered and said no, for
//      example "item not found": not a failure of the dependency). A success and a `rejected`
//      count as a good attempt in the breaker; a `failure` counts as a failed one;
//   5. retry only when the attempt was a `failure`, `kind` is `idempotent_read` and fewer than
//      `maxRetries` retries were made: wait the backoff, then start again at step 1.
// The call rejects with the error of its last attempt (the operation's own error, or the
// `GovernanceError` of the timeout); `circuit_open` and `quota_exceeded` are never retried.
//
// Breaker details: an attempt counts while it is younger than `windowMs` (recorded at time t,
// it counts at any time < t + windowMs). After every recorded attempt: if the window holds at
// least `minRequests` attempts and failed × 100 > failureRatePercent × total, the breaker opens
// until now + openMs. At that instant it is closed again and starts with an empty window.
//
// Quota details: one bucket per purpose. Its capacity is floor(capacity × share / 100) tokens,
// it starts full and refills continuously at refillPerSecond × share / 100 tokens per second,
// never above its capacity. `tryAcquire` takes one whole token or returns false. `online` takes
// from its own bucket first and from the `pool_refresh` bucket when its own has no whole token;
// no other purpose borrows.
//
// Rules for the implementation:
// - This directory is also compiled by the `test` project: erasable syntax only (no parameter
//   properties, no enum, no namespace, no decorators), `import type` for type-only imports,
//   relative imports with the `.ts` extension, no NestJS, no `process.env`, no logging.
// - No new dependency. Time comes only from the `Scheduler` (monotonic milliseconds): never the
//   wall clock, never `AbortSignal.timeout`, never a bare `setTimeout` outside the default
//   scheduler. Every wait started by a call is cancelled when the call settles.
// - No HTTP client here: the operation is the caller's function; this module only governs it.

export type GovernanceErrorCode = 'timeout' | 'circuit_open' | 'quota_exceeded' | 'invalid_policy';

/** Thrown by this module. `dependency` is the name given to `createGovernor`. */
export class GovernanceError extends Error {
  readonly code: GovernanceErrorCode;
  readonly dependency: string;

  constructor(code: GovernanceErrorCode, dependency: string, message: string) {
    super(message);
    this.name = 'GovernanceError';
    this.code = code;
    this.dependency = dependency;
  }
}

/** Monotonic time and cancellable waiting; tests inject a manual one. */
export interface Scheduler {
  /** Milliseconds from a monotonic source. */
  now(): number;
  /**
   * Resolves once `ms` milliseconds have passed. When `signal` aborts first, the wait is
   * cancelled (its timer is released) and the promise rejects with `signal.reason`.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface RetryPolicy {
  /** Retries after the first attempt; 0 disables retrying. Integer 0..10. */
  readonly maxRetries: number;
  /** Backoff before the first retry, in ms. Integer ≥ 1. */
  readonly baseDelayMs: number;
  /** Upper bound of one backoff, in ms. Integer ≥ baseDelayMs. */
  readonly maxDelayMs: number;
}

export interface BreakerPolicy {
  /** Length of the sliding window, in ms. Integer ≥ 1. */
  readonly windowMs: number;
  /** Attempts the window must hold before the breaker may open. Integer ≥ 1. */
  readonly minRequests: number;
  /** The breaker opens when the failure rate is ABOVE this percentage. Integer 0..99. */
  readonly failureRatePercent: number;
  /** How long the breaker stays open, in ms. Integer ≥ 1. */
  readonly openMs: number;
}

export interface GovernancePolicy {
  /** Time limit of one attempt, in ms. Integer ≥ 1. */
  readonly timeoutMs: number;
  /** Named `retries`, not `retry`: test files may not contain `retry:` (tools/guard test-guard). */
  readonly retries: RetryPolicy;
  readonly breaker: BreakerPolicy;
}

export type CallKind = 'idempotent_read' | 'write';

export type QuotaPurpose = 'online' | 'order_sync' | 'pool_refresh' | 'watch';

/** Percentages per purpose; integers 0..100 that add up to 100. */
export type QuotaShares = Readonly<Record<QuotaPurpose, number>>;

export interface QuotaConfig {
  /** What the upstream counts the quota by (union account or appkey): configurable, non-empty. */
  readonly bucketKey: string;
  /** Burst size of the whole bucket, in tokens. Integer ≥ 1. */
  readonly capacity: number;
  /** Refill of the whole bucket, in tokens per second. Finite, > 0. */
  readonly refillPerSecond: number;
  readonly shares: QuotaShares;
}

export interface QuotaLimiter {
  readonly bucketKey: string;
  /** Takes one token for `purpose`; false when none is available. */
  tryAcquire(purpose: QuotaPurpose): boolean;
}

export interface CallOptions {
  readonly kind: CallKind;
  /** Purpose of the quota token; without it (or without a limiter) no token is taken. */
  readonly purpose?: QuotaPurpose;
  /** Tells a failure of the dependency from an answer that says no. Default: `failure`. */
  readonly classify?: (error: unknown) => 'failure' | 'rejected';
}

export interface GovernorDeps {
  /** Default: `systemScheduler()`. */
  readonly scheduler?: Scheduler;
  /** Default: no quota. */
  readonly quota?: QuotaLimiter;
}

export interface Governor {
  readonly dependency: string;
  /** `open` while calls are rejected with `circuit_open`, else `closed`. */
  breakerState(): 'closed' | 'open';
  call<T>(operation: (signal: AbortSignal) => Promise<T>, options: CallOptions): Promise<T>;
}

/** The scheduler used outside tests: `performance.now()` and cancellable timers. */
export function systemScheduler(): Scheduler {
  return {
    now: () => performance.now(),
    sleep(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(signal.reason);
          return;
        }
        const duration = Number.isNaN(ms) ? 0 : Math.max(0, ms);
        const started = performance.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancel = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          reject(signal?.reason);
        };
        const schedule = (remaining: number): void => {
          // Node otherwise turns delays above the signed 32-bit limit into 1 ms.
          timer = setTimeout(tick, Math.min(2_147_483_647, Math.ceil(remaining)));
        };
        const tick = (): void => {
          const remaining = duration - (performance.now() - started);
          if (remaining > 0) {
            schedule(remaining);
          } else {
            signal?.removeEventListener('abort', cancel);
            resolve();
          }
        };
        signal?.addEventListener('abort', cancel, { once: true });
        if (duration !== Infinity) schedule(duration);
      });
    },
  };
}

/** The policy of 规划/02 §6.2 for union platform calls. */
export function unionPolicy(mode: 'online' | 'offline'): GovernancePolicy {
  return {
    timeoutMs: mode === 'online' ? 3000 : 10000,
    retries: { maxRetries: 2, baseDelayMs: 200, maxDelayMs: 2000 },
    breaker: { windowMs: 10000, minRequests: 20, failureRatePercent: 50, openMs: 30000 },
  };
}

/** The split of 规划/02 §6.2: `mvp` 60 / 30 / 10 / 0, `p1` (reminders on) 60 / 30 / 5 / 5. */
export function quotaShares(stage: 'mvp' | 'p1'): QuotaShares {
  return {
    online: 60,
    order_sync: 30,
    pool_refresh: stage === 'mvp' ? 10 : 5,
    watch: stage === 'mvp' ? 0 : 5,
  };
}

const PURPOSES: readonly QuotaPurpose[] = ['online', 'order_sync', 'pool_refresh', 'watch'];

function integerInRange(value: number, min: number, max: number = Number.MAX_VALUE): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * In-process token buckets (one per purpose) for one bucket key. Throws `invalid_policy` when
 * the configuration breaks a constraint written on `QuotaConfig` / `QuotaShares`. A Redis-backed
 * limiter with the same interface arrives with a later task.
 */
export function createMemoryQuotaLimiter(
  config: QuotaConfig,
  scheduler: Scheduler = systemScheduler(),
): QuotaLimiter {
  if (
    typeof config?.bucketKey !== 'string' ||
    config.bucketKey.trim() === '' ||
    !integerInRange(config.capacity, 1) ||
    !Number.isFinite(config.refillPerSecond) ||
    config.refillPerSecond <= 0 ||
    !PURPOSES.every((purpose) => integerInRange(config.shares?.[purpose], 0, 100)) ||
    PURPOSES.reduce((sum, purpose) => sum + config.shares[purpose], 0) !== 100
  ) {
    throw new GovernanceError('invalid_policy', config?.bucketKey ?? '', 'Invalid quota policy');
  }
  // Snapshot the values: mutating the input after validation cannot alter a live limiter.
  // Parse the shortest decimal representation, including exponent notation, before doing
  // any arithmetic on the rate. Multiplying a binary fraction first can lose a whole token.
  const [mantissa = '', exponent = '0'] = String(config.refillPerSecond).split('e');
  const [whole = '', fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  const numerator = BigInt(whole + fraction) * 10n ** BigInt(Math.max(0, -scale));
  const denominator = 10n ** BigInt(Math.max(0, scale)) * 100n * 1_000_000_000n;
  const startedAt = scheduler.now();
  const buckets = new Map(
    PURPOSES.map((purpose) => {
      const capacity = Math.floor((config.capacity * config.shares[purpose]) / 100);
      return [
        purpose,
        {
          capacity,
          consumed: 0n,
          startedAt,
          rateNumerator: numerator * BigInt(config.shares[purpose]),
        },
      ];
    }),
  );
  const take = (purpose: QuotaPurpose, now: number): boolean => {
    const bucket = buckets.get(purpose);
    if (bucket === undefined || bucket.capacity < 1) return false;
    // Recompute from a fixed origin; acquisitions subtract only whole tokens, so polling
    // cannot accumulate fractional refill errors. Reset the origin only when full, discarding
    // any overflow instead of banking tokens beyond capacity.
    const elapsedNs = BigInt(Math.round((now - bucket.startedAt) * 1_000_000));
    const refilled = elapsedNs * bucket.rateNumerator;
    if (refilled >= bucket.consumed * denominator) {
      bucket.startedAt = now;
      bucket.consumed = 0n;
    } else if (BigInt(bucket.capacity) - bucket.consumed + refilled / denominator < 1n) {
      return false;
    }
    bucket.consumed += 1n;
    return true;
  };
  return {
    bucketKey: config.bucketKey,
    tryAcquire(purpose) {
      const now = scheduler.now();
      return take(purpose, now) || (purpose === 'online' && take('pool_refresh', now));
    },
  };
}

/** Settle before aborting: an upstream abort handler must not turn a timeout into success. */
function attempt<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  scheduler: Scheduler,
  timeoutMs: number,
  timeoutError: GovernanceError,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const deadline = scheduler.now() + timeoutMs;
    const operationController = new AbortController();
    const timerController = new AbortController();
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      timerController.abort();
      settle();
    };
    const expire = (): void => {
      if (settled) return;
      finish(() => reject(timeoutError));
      operationController.abort(timeoutError);
    };
    const accept = (settle: () => void): void => {
      if (scheduler.now() >= deadline) expire();
      else finish(settle);
    };
    void scheduler
      .sleep(timeoutMs, timerController.signal)
      .then(expire, (error: unknown) => finish(() => reject(error)));
    try {
      void operation(operationController.signal).then(
        (value) => accept(() => resolve(value)),
        (error: unknown) => accept(() => reject(error)),
      );
    } catch (error) {
      accept(() => reject(error));
    }
  });
}

/**
 * A governor for one dependency (one breaker). `dependency` is a non-empty name used in errors.
 * Throws `invalid_policy` when the policy breaks a constraint written on the policy types.
 */
export function createGovernor(
  dependency: string,
  policy: GovernancePolicy,
  deps?: GovernorDeps,
): Governor {
  if (
    typeof dependency !== 'string' ||
    dependency.trim() === '' ||
    !integerInRange(policy?.timeoutMs, 1) ||
    !integerInRange(policy.retries?.maxRetries, 0, 10) ||
    !integerInRange(policy.retries?.baseDelayMs, 1) ||
    !integerInRange(policy.retries?.maxDelayMs, policy.retries.baseDelayMs) ||
    !integerInRange(policy.breaker?.windowMs, 1) ||
    !integerInRange(policy.breaker?.minRequests, 1) ||
    !integerInRange(policy.breaker?.failureRatePercent, 0, 99) ||
    !integerInRange(policy.breaker?.openMs, 1)
  ) {
    throw new GovernanceError('invalid_policy', dependency, 'Invalid governance policy');
  }
  const { timeoutMs } = policy;
  const retries = { ...policy.retries };
  const breaker = { ...policy.breaker };
  const scheduler = deps?.scheduler ?? systemScheduler();
  const quota = deps?.quota;
  let openUntil: number | undefined;
  let records: { at: number; failed: boolean }[] = [];
  let head = 0;
  let failures = 0;

  const breakerState = (): 'closed' | 'open' => {
    if (openUntil !== undefined) {
      if (scheduler.now() < openUntil) return 'open';
      openUntil = undefined;
      records = [];
      head = 0;
      failures = 0;
    }
    return 'closed';
  };
  const record = (failed: boolean): void => {
    // In-flight completions must not extend an already open circuit's recovery deadline.
    if (breakerState() === 'open') return;
    const now = scheduler.now();
    while (head < records.length) {
      const oldest = records[head];
      if (oldest === undefined || now - oldest.at < breaker.windowMs) break;
      if (oldest.failed) failures -= 1;
      head += 1;
    }
    if (head > 0 && head * 2 >= records.length) {
      records = records.slice(head);
      head = 0;
    }
    records.push({ at: now, failed });
    if (failed) failures += 1;
    const total = records.length - head;
    if (total >= breaker.minRequests && failures * 100 > breaker.failureRatePercent * total) {
      openUntil = now + breaker.openMs;
    }
  };
  return {
    dependency,
    breakerState,
    async call(operation, options) {
      const { kind, purpose, classify } = options;
      const waits = new AbortController();
      try {
        for (let retried = 0; ; retried += 1) {
          if (breakerState() === 'open') {
            throw new GovernanceError('circuit_open', dependency, 'Dependency circuit is open');
          }
          if (quota !== undefined && purpose !== undefined && !quota.tryAcquire(purpose)) {
            throw new GovernanceError('quota_exceeded', dependency, 'Dependency quota exhausted');
          }
          const timeoutError = new GovernanceError('timeout', dependency, 'Dependency timed out');
          try {
            const value = await attempt(operation, scheduler, timeoutMs, timeoutError);
            record(false);
            return value;
          } catch (error) {
            let failed = true;
            if (error !== timeoutError) {
              try {
                failed = classify?.(error) !== 'rejected';
              } catch {
                // A broken classifier must not hide the upstream error or bypass the breaker.
              }
            }
            record(failed);
            if (!failed || kind !== 'idempotent_read' || retried >= retries.maxRetries) throw error;
          }
          await scheduler.sleep(
            Math.min(retries.maxDelayMs, retries.baseDelayMs * 2 ** retried),
            waits.signal,
          );
        }
      } finally {
        waits.abort();
      }
    },
  };
}
