// B2-06c: read-only access to payout_attempts for the api / worker side (couli_app has SELECT only;
// the payout process writes attempts, B2-06d). Implements B2-05e's WithdrawalAttemptsPort:
// hasAttempt(trx, withdrawalId, kinds, results?) is true when the withdrawal has an attempt of one of
// `kinds` and, when `results` is given, one of those results; omitted `results` means any result,
// a definite failure included. Reads on the caller's transaction; no writes, no logging.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { WithdrawalAttemptsPort } from '../application/withdrawal-commands.ts';

export interface PayoutAttemptsStore extends WithdrawalAttemptsPort {
  /** EXECUTE ② (BR-WDR-12): any kind=transfer attempt of the withdrawal, whatever its result. */
  hasTransfer(
    trx: Transaction<DB>,
    input: { appId: string; withdrawalId: string },
  ): Promise<boolean>;
}

export function createPayoutAttemptsStore(): PayoutAttemptsStore {
  throw new Error('NotImplemented: createPayoutAttemptsStore');
}
