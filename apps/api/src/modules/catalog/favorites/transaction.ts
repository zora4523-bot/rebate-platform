// B1-28e: the outer transaction of a favorites write. The three write routes run in platform
// idempotency's transactional mode (executeInTransaction): the idempotency record and the
// favorites write commit together or not at all, so a crash between the business commit and the
// `completed` write can no longer let a retry delete a favorite re-added in the meantime.
//
// The transaction reaches the use cases through an AsyncLocalStorage rather than a fifth call
// argument: addFavorite / removeFavorite / removeFavorites keep their exact call shape (the
// B1-28c route tests pin the arguments). Without a store the use cases open their own
// transaction as before (B1-28b semantics unchanged).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

const OUTER = new AsyncLocalStorage<Transaction<DB>>();

/**
 * Runs `work` with `trx` as the transaction of every favorites write it makes: the per-user lock
 * (transaction-scoped) and the reads and writes all happen in `trx`, which the caller commits or
 * rolls back. The store is scoped to `work`.
 */
export function runInFavoritesTransaction<T>(
  trx: Transaction<DB>,
  work: () => Promise<T>,
): Promise<T> {
  return OUTER.run(trx, work);
}

/** The outer transaction set by runInFavoritesTransaction; undefined anywhere else. */
export function outerFavoritesTransaction(): Transaction<DB> | undefined {
  return OUTER.getStore();
}
