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
  return {
    async hasAttempt(trx, withdrawalId, kinds, results) {
      if (kinds.length === 0 || results?.length === 0) return false;
      let query = trx
        .withSchema('app')
        .selectFrom('payout_attempts')
        .select('id')
        .where('withdrawal_id', '=', withdrawalId)
        .where('kind', 'in', [...kinds]);
      if (results !== undefined) query = query.where('result', 'in', [...results]);
      const row = await query.limit(1).executeTakeFirst();
      return row !== undefined;
    },
    async hasTransfer(trx, input) {
      const row = await trx
        .withSchema('app')
        .selectFrom('payout_attempts')
        .select('id')
        .where('app_id', '=', input.appId)
        .where('withdrawal_id', '=', input.withdrawalId)
        .where('kind', '=', 'transfer')
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}
