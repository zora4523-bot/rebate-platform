// B2-07e (D10-428): the payout process's handler of queue `payout-attempt-append` (couli_payout,
// concurrency 1). W11 (application/withdrawal-proven-success.ts) queues one job on its own
// transaction; this handler appends the attempt record of that W11 (规划/08 BR-WDR-08 W11: kind
// query, result success, the bill line as its evidence):
//   idempotent on (withdrawal_id, recon_diff_id): a kind=query, result=success row whose request
//   has source 'w11' and the same recon_diff_id already there → done; else one INSERT (request
//   { source: 'w11', recon_diff_id, bill_date, operator }, response the bill line's summary,
//   resp_code 'BILL_LINE', result 'success'). Existing rows are never changed.
//   A failure is thrown for the queue's retry; the last attempt logs logger.error with the alert
//   payout_attempt_append_failed. Logs carry ids only.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, JobHandler } from '../../platform/index.ts';

/** The payout process's queue of the W11 attempt records (platform/queue catalog and plan). */
export type PayoutAttemptAppendQueue = 'payout-attempt-append';

/** The alert of an attempt record that could not be appended after the last retry. */
export type PayoutAttemptAppendAlert = 'payout_attempt_append_failed';

export interface AttemptAppendLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface AttemptAppendJobOptions {
  /** couli_payout: the only role that may insert payout_attempts. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: AttemptAppendLogger;
}

export function createAttemptAppendJob(options: AttemptAppendJobOptions): JobHandler {
  void options;
  throw new Error('NotImplemented: createAttemptAppendJob');
}
