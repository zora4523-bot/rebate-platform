// B1-13g: scheduled driving only; takeover/recheck remain B1-13f's single writer.
// Multiple workers may query the same request (query is free); status + row_version CAS alone
// decides the winner. No transaction/advisory lock may span a supplier call.
// The local fake remembers only this process's requests: API requests queried by a separate
// worker return not_found. This accepted demonstration limitation must not be hidden.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { PayoutAccountVerifyAttempts } from './payout-account-verify-attempts.ts';

// The runtime constant is added during implementation; test-phase skeletons cannot define const.
export type PAYOUT_VERIFY_RECHECK_INTERVAL_MS = 60_000;

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

export function createPayoutVerifyRecheck(
  options: PayoutVerifyRecheckOptions,
): PayoutVerifyRecheck {
  void options;
  throw new Error('NotImplemented: createPayoutVerifyRecheck');
}

export function startPayoutVerifyRecheck(
  resolve: () => unknown,
  logger: RootLogger,
  stopping: () => boolean,
  schedule?: PayoutVerifyRecheckSchedule,
): PayoutVerifyRecheckControl {
  void resolve;
  void logger;
  void stopping;
  void schedule;
  throw new Error('NotImplemented: startPayoutVerifyRecheck');
}

export function payoutVerifyRecheckToken(): symbol {
  throw new Error('NotImplemented: payoutVerifyRecheckToken');
}
