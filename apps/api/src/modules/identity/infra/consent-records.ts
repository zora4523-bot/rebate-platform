// app.consent_records (规划/08 BR-ID-12; 04 §3.2): insert-only, written only by identity (规划/02
// §4.1). Every function runs in the caller's transaction; nothing here commits. Reused by the
// consent endpoint (B1-02f).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import type { Insertable, Transaction } from 'kysely';
import type { ConsentState } from '../domain/login.ts';

export type NewConsentRecord = Insertable<DB['consent_records']>;

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
