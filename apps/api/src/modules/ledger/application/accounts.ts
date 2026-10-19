// BR-FUND-13: the single balance account of a user, opened in the registration transaction.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { ensureUserAccount, inSavepoint } from '../infra/store.ts';
import { LedgerError } from './errors.ts';

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('INVALID_INPUT', `${name} must be a nonempty string`);
  }
  return value;
}

/**
 * Creates the user's USER_BALANCE account (app.ledger_accounts) and its zero balance row
 * (app.account_balances: available 0, frozen 0, version 0, negative_since NULL) in the caller's
 * transaction. Idempotent: existing rows are neither duplicated nor changed (ON CONFLICT DO
 * NOTHING), also when a concurrent transaction opens the same account. Empty appId / userId →
 * LedgerError INVALID_INPUT before any SQL. Runs in a savepoint, so a failure leaves the
 * caller's transaction usable; the error is never swallowed.
 */
export async function openUserAccount(
  trx: Transaction<DB>,
  input: { readonly appId: string; readonly userId: string },
): Promise<void> {
  if (typeof input !== 'object' || input === null) {
    throw new LedgerError('INVALID_INPUT', 'input must be an object');
  }
  const appId = text(input.appId, 'appId');
  const userId = text(input.userId, 'userId');
  await inSavepoint(trx, () => ensureUserAccount(trx, appId, userId));
}
