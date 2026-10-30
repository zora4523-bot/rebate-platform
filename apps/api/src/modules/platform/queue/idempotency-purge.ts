// Daily purge of expired idempotency records (B1-15za; 08 BR-ID-30 ⑤ idempotency_keys 30 天（按
// expire_at）, 每日 04:00（+08:00）删除任务; 规划/02 §7.1). The worker runs it the way it runs the dead
// letter scan (dead-letter-scan.ts, B1-01zzg): from an internal pg-boss schedule on an internal
// queue of the worker runtime. The rule tests in test/spec/platform/idempotency-purge/** import this
// file by path; the names, signatures and semantics written here are the contract.
//
// 1. One tick — `runIdempotencyPurge({ idempotency, logger })`
//    Calls idempotency.purgeExpired() once (platform/idempotency contract section 7: rows of any
//    status and any app with expire_at < clock.now() go, expire_at = 'infinity' stays) and logs
//    exactly one line through `logger` itself: level info, message `idempotency_purged`, fields
//    exactly { deleted } (the number purgeExpired resolved with; 0 is logged too). Never a key, a
//    request or a response. A purgeExpired that rejects: the same error rejects unchanged and this
//    function logs nothing; the executor's `job_failed_final` is the only line of that tick.
//
// 2. The internal queue and schedule, both named `idempotency-purge`
//    - Not a catalog queue: no entry plan names it, register and send answer 'unknown_queue'.
//    - Queue settings: standard, retryLimit 0, retryBackoff false, deadLetter null, no partition. A
//      failed tick is not retried and not dead-lettered: the next day's tick purges again.
//    - Schedule: cron '0 20 * * *', tz 'UTC' (04:00 +08:00), data the runtime's job envelope
//      { name, payload }, upserted in start() so a restart replaces the row, never adds a second.
//    - One extra lane of the worker runtime, as the dead letter scan's: concurrency 1, polling every
//      2 s, outside the shared budget of the business lanes. No round at start.
//
// 3. Wiring — `scheduleIdempotencyPurge(runtime, idempotency)`
//    Hands the purge to a runtime of createQueueRuntime before its start(); that start() then does
//    section 2. Only a runtime of the worker entry does anything with it: on the other four entries
//    no queue, no schedule and no lane appear. A runtime that never got it behaves as before.
//    apps/api/src/entry.ts, worker branch: after it took JOB_QUEUE and before startWorkerServices it
//    resolves IDEMPOTENCY ({ strict: false }) and calls this. A context without the provider, a null
//    provider or a value without purgeExpired → not called, no crash, no log (as the other optional
//    worker runtimes). The other entries never call it.
//
// 4. Rules: as the rest of this directory (./index.ts section 11); this file reads no time, the
//    clock is the Idempotency instance's. A line is added to ./index.ts section 7 with the
//    implementation.
import type { Idempotency } from '../idempotency/index.ts';
import type { RootLogger } from '../logging/logger.ts';
import type { QueueRuntime } from './types.ts';

/** The one method a tick needs of the platform/idempotency instance. */
export type IdempotencyPurger = Pick<Idempotency, 'purgeExpired'>;

export interface IdempotencyPurgeOptions {
  readonly idempotency: IdempotencyPurger;
  readonly logger: RootLogger;
}

/** Section 1. */
export function runIdempotencyPurge(options: IdempotencyPurgeOptions): Promise<void> {
  void options;
  throw new Error('NotImplemented: runIdempotencyPurge');
}

/** Section 3. */
export function scheduleIdempotencyPurge(
  runtime: QueueRuntime,
  idempotency: IdempotencyPurger,
): void {
  void runtime;
  void idempotency;
  throw new Error('NotImplemented: scheduleIdempotencyPurge');
}
