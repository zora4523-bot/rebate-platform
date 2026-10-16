// app.user_tip_reads (规划/04 §3.2; BR-ATTR-21, BR-INV-03 细则): written only by identity (规划/02
// §4.1). Primary key (app_id, user_id, tip_key, platform); the application role may SELECT,
// INSERT and DELETE, never UPDATE (migration 0008): a read record keeps its first read_at.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { TipRead } from '../domain/tips.ts';

/** Every read record of one user of one app. */
export async function userTipReads(
  db: Kysely<DB>,
  appId: string,
  userId: string,
): Promise<TipRead[]> {
  return db
    .withSchema('app')
    .selectFrom('user_tip_reads')
    .select(['tip_key', 'platform', 'read_at'])
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .execute();
}

/**
 * Records a tip as read at `at` (the Clock instant, also written as created_at instead of the
 * column's database-time default). An existing record wins: ON CONFLICT DO NOTHING, so a repeated
 * or concurrent call leaves the first read_at.
 */
export async function insertTipRead(
  db: Kysely<DB>,
  record: {
    readonly app_id: string;
    readonly user_id: string;
    readonly tip_key: string;
    readonly platform: string;
    readonly at: Date;
  },
): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('user_tip_reads')
    .values({
      app_id: record.app_id,
      user_id: record.user_id,
      tip_key: record.tip_key,
      platform: record.platform,
      read_at: record.at,
      created_at: record.at,
    })
    .onConflict((conflict) =>
      conflict.columns(['app_id', 'user_id', 'tip_key', 'platform']).doNothing(),
    )
    .execute();
}

/** Deletes every read record of one tip of one user (all platforms). */
export async function deleteTipReads(
  db: Kysely<DB>,
  appId: string,
  userId: string,
  tipKey: string,
): Promise<void> {
  await db
    .withSchema('app')
    .deleteFrom('user_tip_reads')
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .where('tip_key', '=', tipKey)
    .execute();
}
