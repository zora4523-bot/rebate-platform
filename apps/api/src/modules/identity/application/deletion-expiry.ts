// Scheduled processing of deletion requests whose cooling period has ended (task B1-15f; 08 BR-ID-27,
// BR-ID-01; orchestrator brief §9.2 #1-#7 and «已定» 2026-10-21). NotImplemented skeleton written by
// the rule-test author; the implementer fills it in (and may reshape the internals as long as the
// rule tests in test/spec/identity/deletion-expiry/** hold).
//
// One round (runOnce):
//   a. Expired requests: across apps, `status = 'cooling' AND cooling_until <= now`, keyset batches
//      of batchSize (default 100) on (cooling_until, id) until none is left — a deferred request
//      stays in cooling, so reading the first batch only would starve the later ones. Only app_id,
//      id and user_id are selected; the scan takes no lock. A request that throws is one warn line
//      (error_name only) and the round goes on; a stop request is honoured between requests.
//   b. One request = one transaction, `now` read once from the Clock and used for the decision and
//      the writes: ① lockUsersForUpdate (users before deletion_requests, as B1-15d and the funds
//      lane); ② reread the request (id, app_id, status 'cooling', cooling_until <= now) FOR NO KEY
//      UPDATE — none → return (withdrawn, advanced by another worker, repeated run);
//      ③ balance.availableFen on the transaction; ④ available_fen < 0 → transition('cooling',
//      'CANCEL'): cancelled, cancel_reason negative_balance, cancelled_at = now, row_version + 1,
//      updated_at = now (CAS on status and row_version), users untouched,
//      TODO(规划/11 §2.3): 站内信 DELETION_PROGRESS cancelled_negative (BR-TEXT-23) — blocked on B1-15i;
//      ⑤ ≥ 0 and withdrawals.hasNonTerminal → nothing is written, one deferred warn
//      `identity_deletion_deferred` {app_id, deletion_request_id, cooling_until};
//      ⑥ ≥ 0 and every withdrawal terminal → users CAS normal → deleting (row_version + 1,
//      updated_at = now), then transition('cooling', 'PROCESS') → processing (row_version + 1,
//      updated_at = now), same transaction; users.status not normal → nothing written, warn, skip.
//      processed_at (time of done) and balance_snapshot_fen (fixed at application) are not written.
//   c. Overdue: requests in cooling or processing with apply_at <= now - 15 days (coarse filter),
//      keyset batches on (apply_at, id); deadline = 24:00 (+08:00) of the 15th working day after
//      the +08:00 civil date of apply_at (risk's resolveWorkingDayDeadline, calendar read once per
//      (app_id, year) per round); now >= deadline → warn `identity_deletion_overdue`
//      {app_id, deletion_request_id, status, apply_at, deadline_at}.
//   d. Alarm dedup: in-process, key `kind:request_id`, cleared at the +08:00 day change.
//
// The timer (startDeletionExpiry): every 60 s, unref'd, no immediate round, rounds never overlap,
// stop cancels the timer and waits for the current request. A stop already requested, a resolve
// that throws or answers null → no timer, no log line.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { DeletionBalanceReader } from '../ports/deletion-balance.ts';
import type { WithdrawalNonTerminalReader } from '../ports/withdrawal-in-flight.ts';

/** The working-day calendar's configuration (calendar.cn_holidays.<year>, ...cn_makeup_workdays.<year>). */
export interface DeletionCalendarConfigReader {
  configValue(appId: string, key: string): Promise<{ readonly value: unknown } | null>;
}

export interface DeletionExpiryOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly withdrawals: WithdrawalNonTerminalReader;
  readonly balance: DeletionBalanceReader;
  readonly calendar: DeletionCalendarConfigReader;
  readonly batchSize?: number;
}

export interface DeletionExpiry {
  /** The timer passes its stop predicate so shutdown can finish the current request only. */
  runOnce(stopping?: () => boolean): Promise<{ scanned: number }>;
}

export interface DeletionExpiryControl {
  stop(): Promise<void>;
}

export type DeletionExpirySchedule = (
  tick: () => Promise<void>,
  intervalMs: number,
) => { stop(): void };

export function createDeletionExpiry(options: DeletionExpiryOptions): DeletionExpiry {
  void options;
  throw new Error('NotImplemented: createDeletionExpiry');
}

/**
 * Worker-only lifecycle hook (entry.ts, after the payout verification recheck). `resolve` returns
 * the provider of deletionExpiryToken() (null without a database).
 */
export function startDeletionExpiry(
  resolve: () => unknown,
  logger: RootLogger,
  stopping: () => boolean,
  schedule?: DeletionExpirySchedule,
): DeletionExpiryControl {
  void resolve;
  void logger;
  void stopping;
  void schedule;
  throw new Error('NotImplemented: startDeletionExpiry');
}

/** The Nest token of the worker's assembled DeletionExpiry (or null without a database). */
export function deletionExpiryToken(): symbol {
  throw new Error('NotImplemented: deletionExpiryToken');
}
