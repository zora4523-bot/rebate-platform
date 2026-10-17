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

/** The cap of one app, read before the outer transaction took its connection. */
export interface PrefetchedFavoritesCap {
  readonly appId: string;
  readonly value: number;
}

interface OuterContext {
  readonly trx: Transaction<DB>;
  readonly cap: PrefetchedFavoritesCap | undefined;
}

const OUTER = new AsyncLocalStorage<OuterContext>();

/**
 * Runs `work` with `trx` as the transaction of every favorites write it makes: the per-user lock
 * (transaction-scoped) and the reads and writes all happen in `trx`, which the caller commits or
 * rolls back. The store is scoped to `work`.
 *
 * `cap` is favorites.max_per_user read before `trx` was opened (FavoritesService.favoritesCap):
 * the configuration reader may need a second connection from the same pool, and waiting for it
 * while `trx` holds one can exhaust the pool under ordinary concurrency (every connection held by
 * a transaction waiting for the reader). With it, addFavorite asks for no further connection.
 */
export function runInFavoritesTransaction<T>(
  trx: Transaction<DB>,
  work: () => Promise<T>,
  cap?: PrefetchedFavoritesCap,
): Promise<T> {
  return OUTER.run({ trx, cap }, work);
}

/** The outer transaction set by runInFavoritesTransaction; undefined anywhere else. */
export function outerFavoritesTransaction(): Transaction<DB> | undefined {
  return OUTER.getStore()?.trx;
}

/** The cap prefetched for `appId` by runInFavoritesTransaction; undefined when none. */
export function prefetchedFavoritesCap(appId: string): number | undefined {
  const cap = OUTER.getStore()?.cap;
  return cap !== undefined && cap.appId === appId ? cap.value : undefined;
}
