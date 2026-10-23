// B1-28f: catalog's share of identity's deletion cleanup (08 BR-ID-28 「收藏全部删除」, D10-186 ⑤;
// orchestrator ruling D10-311 ②). Shaped as identity's DeletionCleanupStep: called inside the
// cleanup transaction (users row already locked) on the caller's transaction, never opening or
// committing one; re-entrant. app.module assembles it as deletionCleanupPorts.catalog.
// Shares the per-user lock and the delete with FavoritesService.deleteAllFavoritesOfUser.
// Rule tests: test/spec/catalog/favorites-deletion/**.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { deleteAllFavoritesIn, lockFavoritesOfUser } from './user-lock.ts';

export interface FavoritesDeletionInput {
  readonly appId: string;
  readonly userId: string;
  readonly at: Date;
}

/** Deletes every app.favorites row of the user in the app, on the caller's transaction. */
export async function deleteFavoritesForUser(
  trx: Transaction<DB>,
  input: FavoritesDeletionInput,
): Promise<void> {
  // `at` is not a filter: every favorite goes, whatever its created_at (BR-ID-28).
  await lockFavoritesOfUser(trx, input.appId, input.userId);
  await deleteAllFavoritesIn(trx, input.appId, input.userId);
}
