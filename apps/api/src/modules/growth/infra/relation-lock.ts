// The app-level relation write lock (B1-11d review r1 S0; BR-INV-08 ②). Every write that changes
// users.parent_id (self-service binding, admin re-parenting, …) takes this transaction-level
// advisory lock in its own transaction before its relation checks, and keeps it to the end of the
// transaction: two concurrent writes (A under B while B under A, or along a longer chain) can then
// never both pass the descendant walk and close a cycle. Under READ COMMITTED every statement after
// the lock sees what the previous holder committed.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';

/** Namespace of the key, so no other advisory lock of the process can share it. */
export const RELATION_WRITE_LOCK_NAMESPACE = 'growth.relation';

/** The signed 64-bit pg_advisory_xact_lock key of one app's relation writes; stable per app. */
export function relationWriteLockKey(appId: string): bigint {
  // JSON keeps the parts apart even when the app id contains a separator.
  const encoded = JSON.stringify([RELATION_WRITE_LOCK_NAMESPACE, appId]);
  return createHash('sha256').update(encoded, 'utf8').digest().readBigInt64BE(0);
}

/** Waits for the app's relation write lock; released when the caller's transaction ends. */
export async function lockRelationWrites(trx: Transaction<DB>, appId: string): Promise<void> {
  const key = relationWriteLockKey(appId);
  await sql`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`.execute(trx);
}
