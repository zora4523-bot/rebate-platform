// Redis generation key (R-04 option A, task B1-02zi; 规划 docs/changes/20261023-R04, 02 §3.1 Redis
// row draft). Recognises a Redis that was flushed, swapped for an empty instance, or restored from a
// snapshot / backup: the nonce store of BR-ID-09 may then have lost reservations, so for the nonce
// dedup duration (NONCE_TTL_SECONDS, domain/request-signature.ts) signed requests are refused.
//
// Behaviour (rule tests: test/spec/risk/redis-generation/**):
// - One generation key in the `risk` Redis namespace (key name: implementation's choice). Its value
//   is the instant it was created (injected Clock); its TTL is 30 × the renewal interval (60 s).
// - Stage ① asks the gate after the HMAC check and before the nonce reservation:
//   key missing → SET NX it (value = now) and refuse; now < created + NONCE_TTL_SECONDS → refuse;
//   later → go on. The refusal is answered 50001 (like a failed nonce reservation; no new code),
//   reserves no nonce and runs no handler. Concurrent creators: the SET NX winner's value counts,
//   every process derives the refusal period from the shared value, never from its own instant.
// - Redis unavailable → the error propagates (50001), never "let through" (ADR-0001 §4.2 #17).
// - Entering the refusal period logs one warn line (event name: implementation's choice), flat
//   fields only, no device id, nonce, signature or other personal data.
// - Enabled only for APP_ENV staging / prod (the entry injects the switch: entry.ts calls
//   armRedisGeneration(APP_ENV) before building the application; RiskModule / RiskScanModule read
//   isRedisGenerationArmed()); local / test: off, stage ① behaves exactly as without the gate.
//   Tests may enable it explicitly (`enabled: true`).
// - The worker renews every 60 s: key present → refresh the TTL only (value unchanged); key
//   missing → SET NX it (value = now). A worker down for longer than the TTL lets the key expire,
//   which counts as data loss (the next signed request recreates it and the period starts).
// - Runbook (ops, not this task): after a snapshot / backup restore or an AOF repair, delete the
//   generation key before letting the applications in.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`, no decorators.
import {
  RedisUnavailableError,
  type AppEnv,
  type Clock,
  type RedisHandle,
  type RedisNamespace,
  type RootLogger,
} from '../../platform/index.ts';
import { NONCE_TTL_SECONDS } from '../domain/request-signature.ts';

export interface RedisGenerationOptions {
  /** Missing or failing Redis fails closed (the error propagates). */
  readonly redis?: Pick<RedisHandle, 'namespace'>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** isRedisGenerationEnabled(APP_ENV) on the entries; false: admit() never refuses or reads. */
  readonly enabled: boolean;
}

/** Stage ①'s question to the generation key, asked right before the nonce reservation. */
export interface RedisGenerationGate {
  /** Resolves: the request may reserve its nonce. Rejects: refuse it (answered 50001). */
  admit(): Promise<void>;
}

export interface RedisGenerationRenewalOptions {
  readonly redis: Pick<RedisHandle, 'namespace'>;
  readonly clock: Clock;
  /** Optional: a renewal that had to create the key logs one warn line. */
  readonly logger?: RootLogger;
}

/** The worker's renewal of the generation key. */
export interface RedisGenerationRenewal {
  /** Key present: refresh its TTL, keep its value. Key missing: SET NX it, value = now. */
  renew(): Promise<void>;
}

export interface RedisGenerationRenewalControl {
  stop(): void;
}

/** Installs a recurring callback; stop cancels its timer. */
export type RedisGenerationSchedule = (
  tick: () => Promise<void>,
  intervalMs: number,
) => RedisGenerationRenewalControl;

export interface RedisGenerationRenewalStart {
  readonly renewal: RedisGenerationRenewal;
  readonly logger: RootLogger;
  /** Absent: an unref'd setInterval. */
  readonly schedule?: RedisGenerationSchedule;
}

/** 9.2 #4: the worker renews the generation key once a minute. */
export const REDIS_GENERATION_RENEW_INTERVAL_MS = 60_000;
/** 9.2 #4: the key's TTL is 30 renewal intervals (whole seconds, as platform/redis requires). */
export const REDIS_GENERATION_TTL_SECONDS = (30 * REDIS_GENERATION_RENEW_INTERVAL_MS) / 1000;
/** 9.2 #1: the refusal period after the key's creation is the nonce dedup duration (BR-ID-09). */
const REFUSAL_MS = NONCE_TTL_SECONDS * 1000;

/** Redis namespace of this module, shared with the nonce store (keys `risk:nonce:…`). */
const NAMESPACE = 'risk';
/** The one generation key of a Redis (full key `risk:generation`). */
const GENERATION_KEY = 'generation';

/**
 * The gate's question, atomic: SET NX the creation instant (ARGV[2]) with the TTL (ARGV[1]);
 * created → {1, value}; already there → {0, its value}. Concurrent creators all read the value of
 * the one SET NX that won.
 */
const ADMIT_SCRIPT = [
  "if redis.call('SET', KEYS[1], ARGV[2], 'NX', 'EX', ARGV[1]) then",
  '  return {1, ARGV[2]}',
  'end',
  "return {0, redis.call('GET', KEYS[1])}",
].join('\n');

/**
 * The worker's renewal, atomic: missing → SET NX now (1); a creation instant → EXPIRE only (0);
 * a value that is no creation instant (not written by this module) → replaced by now (2), so a
 * damaged key starts a refusal period instead of failing every signed request until it expires.
 */
const RENEW_SCRIPT = [
  "local value = redis.call('GET', KEYS[1])",
  'if not value then',
  "  redis.call('SET', KEYS[1], ARGV[2], 'NX', 'EX', ARGV[1])",
  '  return 1',
  'end',
  "if string.match(value, '^[0-9]+$') then",
  "  redis.call('EXPIRE', KEYS[1], ARGV[1])",
  '  return 0',
  'end',
  "redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[1])",
  'return 2',
].join('\n');

/** Decimal epoch milliseconds, as this module writes them. */
const INSTANT = /^[0-9]{1,16}$/;

/** Nest token of the worker's RedisGenerationRenewal (null when not installed). */
const REDIS_GENERATION_RENEWAL = Symbol('REDIS_GENERATION_RENEWAL');

/** The worker's renewal provider (RiskScanModule.forWorker); entry.ts starts it. */
export function redisGenerationRenewalToken(): symbol {
  return REDIS_GENERATION_RENEWAL;
}

/**
 * Stage ① refuses a signed request inside the refusal period. Not a RequestRejection: the global
 * filter answers it 50001, like a failed nonce reservation (9.2 #2, no new code).
 */
export class RedisGenerationRefusalError extends Error {
  constructor() {
    super('risk: Redis generation refusal period; signed requests are refused');
    this.name = 'RedisGenerationRefusalError';
  }
}

/** True for APP_ENV staging / prod, false for local / test. */
export function isRedisGenerationEnabled(appEnv: AppEnv): boolean {
  return appEnv === 'staging' || appEnv === 'prod';
}

/**
 * The process switch (9.2 #5: the entry injects it by APP_ENV). Off until entry.ts arms it, so an
 * application assembled without the process entry (tests calling createHttpApp directly, the
 * contract smoke) never enters a refusal period; RiskModule and RiskScanModule read it when they
 * build the gate and the renewal.
 */
let armed = false;

/** entry.ts only, before the application is built: on for APP_ENV staging / prod, else off. */
export function armRedisGeneration(appEnv: AppEnv): boolean {
  armed = isRedisGenerationEnabled(appEnv);
  return armed;
}

/** Whether this process's entry armed the generation gate and renewal. */
export function isRedisGenerationArmed(): boolean {
  return armed;
}

function instantOf(value: unknown): number {
  if (typeof value !== 'string' || !INSTANT.test(value)) {
    throw new RedisUnavailableError('unexpected_reply');
  }
  const ms = Number(value);
  if (!Number.isSafeInteger(ms)) throw new RedisUnavailableError('unexpected_reply');
  return ms;
}

function nowMs(clock: Clock): number {
  const ms = clock.now().getTime();
  if (!Number.isSafeInteger(ms) || ms < 0) throw new TypeError('risk: invalid clock instant');
  return ms;
}

/** The gate stage ① consults (SignatureDependencies.generation). */
export function createRedisGenerationGate(options: RedisGenerationOptions): RedisGenerationGate {
  const { clock, logger, enabled } = options;
  if (typeof clock?.now !== 'function' || logger === undefined) {
    throw new TypeError('createRedisGenerationGate needs the clock and the logger');
  }
  if (enabled !== true) return Object.freeze({ admit: () => Promise.resolve() });
  const store: RedisNamespace | undefined = options.redis?.namespace(NAMESPACE);
  return Object.freeze({
    async admit(): Promise<void> {
      if (store === undefined) {
        throw new Error('risk: no Redis in this process; signed requests are refused');
      }
      const now = nowMs(clock);
      const reply = await store.eval(ADMIT_SCRIPT, {
        keys: [GENERATION_KEY],
        args: [String(now)],
        ttlSeconds: REDIS_GENERATION_TTL_SECONDS,
      });
      if (!Array.isArray(reply) || reply.length !== 2 || (reply[0] !== 0 && reply[0] !== 1)) {
        throw new RedisUnavailableError('unexpected_reply');
      }
      const createdAt = instantOf(reply[1]);
      const refusalEndsAt = createdAt + REFUSAL_MS;
      if (now >= refusalEndsAt) return;
      if (reply[0] === 1) {
        // 9.2 #6: one warn line when this process entered the period (it created the key).
        logger.warn(
          { generation_created_at: createdAt, refusal_ends_at: refusalEndsAt },
          'redis_generation_refusal_started',
        );
      }
      throw new RedisGenerationRefusalError();
    },
  });
}

/** The worker's renewal over its REDIS handle. */
export function createRedisGenerationRenewal(
  options: RedisGenerationRenewalOptions,
): RedisGenerationRenewal {
  const { clock, logger } = options;
  if (typeof clock?.now !== 'function' || typeof options.redis?.namespace !== 'function') {
    throw new TypeError('createRedisGenerationRenewal needs the Redis handle and the clock');
  }
  const store = options.redis.namespace(NAMESPACE);
  return Object.freeze({
    async renew(): Promise<void> {
      const now = nowMs(clock);
      const reply = await store.eval(RENEW_SCRIPT, {
        keys: [GENERATION_KEY],
        args: [String(now)],
        ttlSeconds: REDIS_GENERATION_TTL_SECONDS,
      });
      if (reply !== 0 && reply !== 1 && reply !== 2) {
        throw new RedisUnavailableError('unexpected_reply');
      }
      if (reply !== 0) {
        logger?.warn(
          {
            generation_created_at: now,
            refusal_ends_at: now + REFUSAL_MS,
            replaced: reply === 2,
          },
          'redis_generation_recreated',
        );
      }
    },
  });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** setInterval, unref'd so the renewal timer alone never keeps the process alive. */
const intervalSchedule: RedisGenerationSchedule = (tick, intervalMs) => {
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
};

/**
 * Worker only: renews every 60 seconds until stop(). A failing renewal never rejects the tick and
 * the next tick runs as usual; after stop() a tick already queued renews nothing.
 */
export function startRedisGenerationRenewal(
  start: RedisGenerationRenewalStart,
): RedisGenerationRenewalControl {
  const { renewal, logger } = start;
  const schedule = start.schedule ?? intervalSchedule;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await renewal.renew();
    } catch (error) {
      logger.warn({ error_name: errorName(error) }, 'redis_generation_renew_failed');
    }
  };
  const timer = schedule(tick, REDIS_GENERATION_RENEW_INTERVAL_MS);
  // One renewal right away: a worker start recreates a lost key without waiting a minute.
  void tick();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      timer.stop();
    },
  };
}
