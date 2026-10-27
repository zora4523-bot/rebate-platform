// Ledger's read port for the withdrawal risk-flag snapshot (task B2-11a; 08 BR-WDR-29 ② ⑦). The
// member's own user balance account only (ledger_accounts owner_type user); on the caller's handle,
// plain SELECTs, no balance lock, no writes, no logging. Time bounds are the caller's (from
// @couli/domain day functions), never a SQL clock.
// - creditedBetween: an entry of one of the given ledger types booked in [from, to].
// - hadNegative: an entry whose balance_after_fen is below 0, ever.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export interface WithdrawRiskEntryReader {
  creditedBetween(
    handle: Kysely<DB>,
    input: { appId: string; userId: string; ledgerTypes: readonly string[]; from: Date; to: Date },
  ): Promise<boolean>;
  hadNegative(handle: Kysely<DB>, input: { appId: string; userId: string }): Promise<boolean>;
}

export function createWithdrawRiskEntryReader(): WithdrawRiskEntryReader {
  function ownEntries(handle: Kysely<DB>, appId: string, userId: string) {
    return handle
      .withSchema('app')
      .selectFrom('ledger_entries as e')
      .innerJoin('ledger_accounts as a', (join) =>
        join.onRef('a.id', '=', 'e.account_id').onRef('a.app_id', '=', 'e.app_id'),
      )
      .select(sql<number>`1`.as('one'))
      .where('e.app_id', '=', appId)
      .where('a.owner_type', '=', 'user')
      .where('a.owner_id', '=', userId);
  }
  return {
    async creditedBetween(handle, input) {
      if (input.ledgerTypes.length === 0) return false;
      const row = await ownEntries(handle, input.appId, input.userId)
        .where('e.ledger_type', 'in', [...input.ledgerTypes])
        .where('e.booked_at', '>=', input.from)
        .where('e.booked_at', '<=', input.to)
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },
    async hadNegative(handle, input) {
      const row = await ownEntries(handle, input.appId, input.userId)
        .where('e.balance_after_fen', '<', 0n)
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}
