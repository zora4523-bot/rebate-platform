// app.consent_records (规划/08 BR-ID-12; 04 §3.2): insert-only, written only by identity (规划/02
// §4.1). Every function runs in the caller's transaction; nothing here commits. Reused by the
// consent endpoint (B1-02f).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import { sql, type Insertable, type Transaction } from 'kysely';
import type { ConsentState } from '../domain/login.ts';

/**
 * created_at is required: it is written from the same Clock instant as server_at, never left to
 * the column's DEFAULT now() (database time; apps/api reads time only from the injected Clock).
 */
export type NewConsentRecord = Insertable<DB['consent_records']> & { readonly created_at: Date };

/** Inserts the records in the given order (ids follow it); nothing is ever updated. */
export async function insertConsentRecords(
  trx: Transaction<DB>,
  records: readonly NewConsentRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await trx
    .insertInto('consent_records')
    .values([...records])
    .execute();
}

/**
 * Transaction-level lock of one user's consent records (BR-ID-12 login_merge). Two logins of the
 * same user on two devices would otherwise both read the old user-level current state under READ
 * COMMITTED and each copy its device's record, so the final current state could be the lower
 * version. Taken before the user-level records are written or read, held until the caller's
 * transaction ends; later statements of the waiting transaction see what the first one committed.
 * Its key (a 64-bit hash of a name prefixed by this table) is disjoint from the device
 * registration lock (identity.device_registrations:…) and the idempotency two-int4 locks.
 */
export async function lockUserConsents(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity.consent_records.user:${appId}:${userId}`}, 0))`.execute(
    trx,
  );
}

/** Every device-level record of one installation (the current state is chosen by the caller). */
export async function deviceConsentRecords(
  trx: Transaction<DB>,
  appId: string,
  deviceId: string,
): Promise<ConsentState[]> {
  return trx
    .selectFrom('consent_records')
    .select(['id', 'type', 'version', 'accepted', 'client_at', 'server_at'])
    .where('app_id', '=', appId)
    .where('subject_type', '=', 'device')
    .where('device_id', '=', deviceId)
    .execute();
}

/** Every user-level record of one user. */
export async function userConsentRecords(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<ConsentState[]> {
  return trx
    .selectFrom('consent_records')
    .select(['id', 'type', 'version', 'accepted', 'client_at', 'server_at'])
    .where('app_id', '=', appId)
    .where('subject_type', '=', 'user')
    .where('user_id', '=', userId)
    .execute();
}
