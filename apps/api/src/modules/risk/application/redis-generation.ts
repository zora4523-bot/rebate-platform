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
// - Enabled only for APP_ENV staging / prod (the entry injects the switch); local / test: off,
//   stage ① behaves exactly as without the gate. Tests may enable it explicitly.
// - The worker renews every 60 s: key present → refresh the TTL only (value unchanged); key
//   missing → SET NX it (value = now). A worker down for longer than the TTL lets the key expire,
//   which counts as data loss (the next signed request recreates it and the period starts).
// - Runbook (ops, not this task): after a snapshot / backup restore or an AOF repair, delete the
//   generation key before letting the applications in.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`, no decorators.
import type { AppEnv, Clock, RedisHandle, RootLogger } from '../../platform/index.ts';

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

/** True for APP_ENV staging / prod, false for local / test. */
export function isRedisGenerationEnabled(appEnv: AppEnv): boolean {
  void appEnv;
  throw new Error('NotImplemented: isRedisGenerationEnabled');
}

/** The gate stage ① consults (SignatureDependencies.generation). */
export function createRedisGenerationGate(options: RedisGenerationOptions): RedisGenerationGate {
  void options;
  throw new Error('NotImplemented: createRedisGenerationGate');
}

/** The worker's renewal over its REDIS handle. */
export function createRedisGenerationRenewal(
  options: RedisGenerationRenewalOptions,
): RedisGenerationRenewal {
  void options;
  throw new Error('NotImplemented: createRedisGenerationRenewal');
}

/**
 * Worker only: renews every 60 seconds until stop(). A failing renewal never rejects the tick and
 * the next tick runs as usual; after stop() a tick already queued renews nothing.
 */
export function startRedisGenerationRenewal(
  start: RedisGenerationRenewalStart,
): RedisGenerationRenewalControl {
  void start;
  throw new Error('NotImplemented: startRedisGenerationRenewal');
}
