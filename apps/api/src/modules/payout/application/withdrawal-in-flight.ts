// B2-05e (D-W04): payout's implementation of identity's two withdrawal reader ports.
//   hasInFlight    a withdrawal in PENDING_REVIEW / APPROVED / PAYING exists AND the user has no
//                  manual hold in effect (a hand-frozen member is settled by finance during the
//                  cooling period, BR-ID-31: identity's deletion flow may go on);
//   hasNonTerminal any withdrawal not in a terminal state, holds ignored (BR-ID-27).
// Reads on the caller's transaction (its uncommitted rows included), no writes, no logging.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

/** Structural implementation of identity's two withdrawal reader ports. */
export interface WithdrawalReaders {
  hasInFlight(trx: Transaction<DB>, input: { appId: string; userId: string }): Promise<boolean>;
  hasNonTerminal(trx: Transaction<DB>, input: { appId: string; userId: string }): Promise<boolean>;
}

const OPEN_STATES: readonly string[] = ['PENDING_REVIEW', 'APPROVED', 'PAYING'];

export function createWithdrawalInFlightReader(options: { clock: Clock }): WithdrawalReaders {
  async function hasOpen(
    trx: Transaction<DB>,
    input: { appId: string; userId: string },
  ): Promise<boolean> {
    const row = await trx
      .withSchema('app')
      .selectFrom('withdrawals')
      .select('id')
      .where('app_id', '=', input.appId)
      .where('user_id', '=', input.userId)
      .where('status', 'in', [...OPEN_STATES])
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }
  return {
    async hasInFlight(trx, input) {
      if (!(await hasOpen(trx, input))) return false;
      const now = options.clock.now();
      const hold = await trx
        .withSchema('app')
        .selectFrom('withdraw_holds')
        .select('id')
        .where('app_id', '=', input.appId)
        .where('user_id', '=', input.userId)
        .where('reason', '=', 'manual')
        .where('released_at', 'is', null)
        .where((eb) => eb.or([eb('hold_until', 'is', null), eb('hold_until', '>', now)]))
        .limit(1)
        .executeTakeFirst();
      return hold === undefined;
    },
    hasNonTerminal: hasOpen,
  };
}
