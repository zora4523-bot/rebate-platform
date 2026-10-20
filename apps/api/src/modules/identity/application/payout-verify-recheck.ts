// Scheduled takeover / recheck of the paid bank-card verification records (规划/08 BR-WDR-02 ⑦ and
// 细则「核验次数上限」: 在途租约、结果未知的复核、复核的终点; task B1-13g §9.2, §9.3).
//
// This file only drives B1-13f's seam (createPayoutAccountVerifyAttempts): takeover / recheck stay
// the single writer of app.payout_account_verify_attempts and own every decision (lease, deadline,
// query outcome, the expired_unresolved alarm line). Nothing here writes payout_accounts,
// payout_account_changes, an idempotency result, released or a refund, and no users lock is taken.
//
// One round (runOnce): across apps, at most batchSize (default 100) rows still reserved / unknown,
// oldest reservation first (reserved_at, then id; the partial unique index
// payout_account_verify_attempts_inflight_key has the same predicate), only (app_id, id) read.
// Each row in turn: takeover, then recheck in the same round (a row taken over is queried at once,
// 细则「置为 unknown 并按请求标识查询」). A row that throws is one warn line (error_name only) and
// the round goes on; a stop request is honoured between rows, never inside one.
//
// Several workers (or a request's in-line recheck) may meet the same row: there is no advisory
// lock (a transaction lock would be held across the supplier call; a session lock would pin a
// pooled connection). Every write is B1-13f's conditional UPDATE on the status and row_version
// read, so exactly one CAS wins and the loser does nothing (no reread, no retry). The price is
// that two workers may both query the supplier for one request: query never re-sends a
// verification and is not charged; the alarm line is written only by the CAS winner.
// No transaction spans a supplier call; time is read from the injected Clock inside B1-13f only.
//
// The timer (startPayoutVerifyRecheck): every PAYOUT_VERIFY_RECHECK_INTERVAL_MS, unref'd, no
// immediate round; a round still running makes the next tick a no-op (no overlap); stop cancels
// the timer and waits for the current row to finish, so nothing is written after the pool closes.
//
// Without a supplier (staging / prod: no real adapter yet) recheck cannot query, so an unknown row
// becomes expired_unresolved at unknown_at + recheck minutes (08 原文). Accepted demonstration
// limitation (§9.3): the local / test fake supplier only knows requests sent by its own process,
// so the worker's query for a request the api process sent answers not_found and the background
// recheck records expired_unresolved at once; the fake is not changed and nothing is shared
// across processes to hide this.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { PayoutAccountVerifyAttempts } from './payout-account-verify-attempts.ts';

/** Interval between two rounds (about the default 60-second lease). */
export const PAYOUT_VERIFY_RECHECK_INTERVAL_MS = 60_000;

/** Rows per round; a full round is logged, never enlarged. */
const DEFAULT_BATCH_SIZE = 100;

const TOKEN = Symbol('IDENTITY_PAYOUT_VERIFY_RECHECK');

export interface PayoutVerifyRecheckOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly attempts: PayoutAccountVerifyAttempts;
  readonly batchSize?: number;
}

export interface PayoutVerifyRecheck {
  /** The timer passes its stop predicate so shutdown can finish the current row only. */
  runOnce(stopping?: () => boolean): Promise<{ scanned: number }>;
}

export interface PayoutVerifyRecheckControl {
  stop(): Promise<void>;
}

export type PayoutVerifyRecheckSchedule = (
  tick: () => Promise<void>,
  intervalMs: number,
) => { stop(): void };

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function batchSizeOf(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_BATCH_SIZE;
}

export function createPayoutVerifyRecheck(
  options: PayoutVerifyRecheckOptions,
): PayoutVerifyRecheck {
  const { db, logger, attempts } = options;
  const batchSize = batchSizeOf(options.batchSize);
  return Object.freeze({
    async runOnce(stopping: () => boolean = () => false): Promise<{ scanned: number }> {
      const rows = await db
        .withSchema('app')
        .selectFrom('payout_account_verify_attempts')
        .select(['app_id', 'id'])
        .where('status', 'in', ['reserved', 'unknown'])
        .orderBy('reserved_at')
        .orderBy('id')
        .limit(batchSize)
        .execute();
      for (const row of rows) {
        if (stopping()) break;
        const subject = { appId: row.app_id, id: row.id };
        try {
          await attempts.takeover(subject);
          await attempts.recheck(subject);
        } catch (error) {
          // The row's content and the error message stay out of the log (they may carry inputs).
          logger.warn({ error_name: errorName(error) }, 'payout_verify_recheck_row_failed');
        }
      }
      if (rows.length >= batchSize) {
        logger.info({ scanned: rows.length }, 'payout_verify_recheck_batch_full');
      }
      return { scanned: rows.length };
    },
  });
}

function isRecheck(value: unknown): value is PayoutVerifyRecheck {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { runOnce?: unknown }).runOnce === 'function'
  );
}

/** setInterval, unref'd so the recheck timer alone never keeps the process alive. */
const intervalSchedule: PayoutVerifyRecheckSchedule = (tick, intervalMs) => {
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
};

const NO_RECHECK: PayoutVerifyRecheckControl = { stop: () => Promise.resolve() };

/**
 * Worker-only lifecycle hook (entry.ts, after the risk-scan heal). `resolve` returns the provider
 * of payoutVerifyRecheckToken() (null without a database). A stop already requested, no runner or
 * a throwing resolve (one warn line, error_name only): no timer at all.
 */
export function startPayoutVerifyRecheck(
  resolve: () => unknown,
  logger: RootLogger,
  stopping: () => boolean,
  schedule: PayoutVerifyRecheckSchedule = intervalSchedule,
): PayoutVerifyRecheckControl {
  if (stopping()) return NO_RECHECK;
  let resolved: unknown;
  try {
    resolved = resolve();
  } catch (error) {
    logger.warn({ error_name: errorName(error) }, 'payout_verify_recheck_failed');
    return NO_RECHECK;
  }
  if (!isRecheck(resolved)) return NO_RECHECK;
  const recheck = resolved;
  let stopped = false;
  let running: Promise<void> | undefined;
  const halted = (): boolean => stopped || stopping();
  const round = async (): Promise<void> => {
    try {
      await recheck.runOnce(halted);
    } catch (error) {
      logger.warn({ error_name: errorName(error) }, 'payout_verify_recheck_failed');
    }
  };
  const timer = schedule(async () => {
    // A round still running (or a stop): this tick does nothing, rounds never overlap.
    if (running !== undefined || halted()) return;
    const current = round();
    running = current;
    try {
      await current;
    } finally {
      if (running === current) running = undefined;
    }
  }, PAYOUT_VERIFY_RECHECK_INTERVAL_MS);
  return {
    async stop() {
      if (!stopped) {
        stopped = true;
        timer.stop();
      }
      // The current row finishes (runOnce checks the stop between rows) before the pool closes.
      await running;
    },
  };
}

/** The Nest token of the worker's assembled PayoutVerifyRecheck (or null without a database). */
export function payoutVerifyRecheckToken(): symbol {
  return TOKEN;
}
