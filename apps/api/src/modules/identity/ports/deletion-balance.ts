// Identity's port for the user's available balance at deletion time (task B1-15d §9.2 #2;
// BR-ID-27 / ADD-07: available_fen < 0 → 30416 with data.amount_fen = -available_fen).
// app.module assembles it over the ledger module's getBalances (through ledger/index.ts only), on
// the caller's transaction: the available_fen of the user's USER_BALANCE row, 0n when the user has
// no ledger account. Amounts are bigint fen end to end (never a JS number). No writes, no logging.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface DeletionBalanceInput {
  readonly appId: string;
  readonly userId: string;
}

export interface DeletionBalanceReader {
  /** available_fen of the user's balance (bigint fen), 0n without an account. */
  availableFen(trx: Transaction<DB>, input: DeletionBalanceInput): Promise<bigint>;
}
