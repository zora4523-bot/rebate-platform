// B2-06fz (D10-326 option C; 规划/02 §5.3 P→A; 规划/08 BR-WDR-13, BR-WDR-14, BR-WDR-09; state
// machine W5 / W6): landing a channel result on the worker (couli_app). The payout process only
// connects as couli_payout, which has no grant on the ledger or users tables, so its transfer and
// query jobs only record the attempt's result and, on the same couli_payout transaction, enqueue
//   queue.send('payout-landing', 'land', { app_id, withdrawal_id, execute_seq, attempt_id },
//     { trx, singletonKey: `${withdrawal_id}:${execute_seq}:land:${attempt_id}` })
// for an attempt whose result is success or fail (response.kind success / fail; a payer-side
// result is W9 on the payout process and is never enqueued). The attempt row's `response` also
// carries channel_order_id, paid_at (the channel's time), status (the channel's status before
// the query_status_map mapping) and received_at (Clock, ISO: when the result came back; a
// transfer attempt's `at` is written before the send). Before it enqueues, the payout process
// re-reads the withdrawal on that transaction: row_version not the one it read at its ①, or no
// longer PAYING / another execute_seq / needs_manual → it only records the attempt and warns
// (payout_landing_skipped), no land job; W10 ends the withdrawal.
//
// createLandingJob(options) is the handler of queue `payout-landing`, job name `land`, payload
// LandingJobPayload (registered by PayoutModule.forWorker; worker entry, concurrency 1). Order:
//   ① read the withdrawal (app_id and id of the payload, no lock) for its user_id →
//      lockUsersForUpdate → read it again FOR NO KEY UPDATE. Missing, another app, status ≠
//      PAYING or execute_seq ≠ the payload's → resolve (info), nothing written. needs_manual =
//      true → resolve, nothing written: after T + 24 h only W10 ends it (BR-WDR-14).
//   ② read the attempt row `attempt_id`: not this withdrawal's (or missing), result ∉
//      { success, fail }, or response.kind ∉ { success, fail } (payer_side is stored as result
//      fail) → logger.warn and resolve, nothing written.
//   ③ success → W5 through application/payout-landing.ts: paid_at = response.paid_at (the
//      channel's time) when it is an instant, else response.received_at, else the attempt row's
//      `at`; channel_order_id = response.channel_order_id; WITHDRAW:SUCCESS:CASH_<channel>
//      `wd:{id}:PAID`.
//      fail → W6 through application/payout-landing.ts: fail_code = resp_sub_code, else
//      response.status, else resp_code; WITHDRAW:RETURN `wd:{id}:RETURN`.
//      Transition, voucher and wallet.withdrawal_changed on one transaction; a CAS that moves no
//      row (row_version changed) only warns: no transition, no voucher, no event, no throw.
// A redelivery, or a second landing job of the same withdrawal (a transfer success followed by a
// query success), stops at ① once the withdrawal left PAYING: the voucher is posted once.
// Logs carry withdrawal_id, attempt_id, out_biz_no and codes only — never the payee's account or
// name.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Ledger } from '../../ledger/index.ts';
import type { Clock, EventBus, JobHandler } from '../../platform/index.ts';
import type { WithdrawApplyOptions } from '../application/withdraw-apply.ts';

/** Queue and job name of a landing (platform/queue/catalog.ts; worker entry only). */
export type PayoutLandingQueue = 'payout-landing';
export type PayoutLandingJobName = 'land';

/** What the payout process enqueues for an attempt whose result is success or fail. */
export interface LandingJobPayload {
  readonly app_id: string;
  readonly withdrawal_id: string;
  readonly execute_seq: number;
  readonly attempt_id: string;
}

/** The attempt row a landing reads (payout_attempts; couli_app may SELECT it). */
export interface LandingAttempt {
  readonly id: string;
  readonly app_id: string;
  readonly withdrawal_id: string;
  readonly kind: string;
  readonly result: string;
  readonly response: unknown;
  readonly resp_code: string | null;
  readonly resp_sub_code: string | null;
  readonly at: Date;
}

/** Reads one attempt row; default: payout_attempts on the landing's own handle. */
export interface LandingAttemptsReader {
  attempt(
    executor: Kysely<DB> | Transaction<DB>,
    input: { readonly appId: string; readonly attemptId: string },
  ): Promise<LandingAttempt | null>;
}

export interface LandingJobLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface LandingJobOptions {
  /** couli_app: withdrawals, ledger, events. */
  readonly db: Kysely<DB>;
  readonly attemptsReader?: LandingAttemptsReader;
  readonly ledger: Ledger;
  /** identity's users row lock (module lock order: users → withdrawal → balances). */
  readonly lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  readonly eventBus: EventBus;
  readonly clock: Clock;
  readonly logger: LandingJobLogger;
}

export function createLandingJob(options: LandingJobOptions): JobHandler {
  void options;
  throw new Error('NotImplemented: createLandingJob');
}
