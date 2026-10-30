// B1-20e: read-only port "has this user's balance any ledger entry" (BR-ID-06 并号条件「余额无任何
// 流水」), for identity's bind-phone merge offer (assembled by app.module as AccountAssetsPort
// hasLedgerEntries).
//
// True when the app's USER_BALANCE account of the user (app.ledger_accounts owner_type=user,
// owner_id=userId, same app_id) has at least one row in app.ledger_entries, whatever its
// ledger_type, sub_account or sign (entries that net to zero still count). No account row → false.
// Reads on the executor the caller passes (its uncommitted writes are visible; no schema set by the
// caller): no write, no lock, no account opened, no Clock, no log.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';

export interface UserLedgerActivitySelection {
  readonly appId: string;
  readonly userId: string;
}

/** True when the user's balance account of the app has any ledger entry. */
export async function hasUserBalanceEntries(
  executor: Kysely<DB> | Transaction<DB>,
  input: UserLedgerActivitySelection,
): Promise<boolean> {
  const row = await executor
    .withSchema('app')
    .selectFrom('ledger_entries as e')
    .innerJoin('ledger_accounts as a', (join) =>
      join.onRef('a.app_id', '=', 'e.app_id').onRef('a.id', '=', 'e.account_id'),
    )
    .select('e.id')
    .where('a.app_id', '=', input.appId)
    .where('a.owner_type', '=', 'user')
    .where('a.owner_id', '=', input.userId)
    .where('a.subject', '=', 'USER_BALANCE')
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}
