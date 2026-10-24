// B1-28b / B1-28f: the per-user favorites lock, shared by the favorites use cases (service.ts) and
// the deletion cleanup port (deletion.ts) so both serialise on the same identity.
import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';

/** The advisory lock key of one user's favorites in one app. */
export function favoritesUserLockKey(appId: string, userId: string): bigint {
  // UUID text is case insensitive in PG; normalise it for the same lock identity.
  return createHash('sha256')
    .update(JSON.stringify(['catalog.favorites', appId, userId.toLowerCase()]))
    .digest()
    .readBigInt64BE(0);
}

/** Takes the user's favorites lock on `trx`; transaction-scoped, held until commit or rollback. */
export async function lockFavoritesOfUser(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<void> {
  const key = favoritesUserLockKey(appId, userId);
  await sql`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`.execute(trx);
}

/** Deletes every favorite of the user in the app on `trx`; the caller holds the user's lock. */
export async function deleteAllFavoritesIn(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<void> {
  await trx
    .withSchema('app')
    .deleteFrom('favorites')
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .execute();
}
