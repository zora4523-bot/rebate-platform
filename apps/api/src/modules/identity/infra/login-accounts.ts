// Reads of a login (规划/08 BR-ID-01 细则「受限会话」, BR-ID-04, BR-INV-09): the existing account of a
// phone and the device row of the request. Runs in the caller's transaction.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface LoginAccount {
  readonly id: string;
  readonly parent_bind_source: string | null;
}

/**
 * The account holding this phone blind index in the app, if any. An account in the deletion
 * cooling-off period counts as existing; a finished deletion (status deleted) does not (BR-ID-01
 * 细则「受限会话·受限登录」). The partial unique index (app_id, phone_hmac) WHERE status <> 'deleted'
 * keeps it at most one row.
 */
export async function findAccountByPhone(
  trx: Transaction<DB>,
  appId: string,
  phoneHmac: string,
): Promise<LoginAccount | undefined> {
  return trx
    .selectFrom('users')
    .select(['id', 'parent_bind_source'])
    .where('app_id', '=', appId)
    .where('phone_hmac', '=', phoneHmac)
    .where('status', '<>', 'deleted')
    .executeTakeFirst();
}

/** device_hash of the request's device row (the registration service reads no devices). */
export async function deviceHashOf(
  trx: Transaction<DB>,
  appId: string,
  deviceId: string,
): Promise<string | undefined> {
  const row = await trx
    .selectFrom('devices')
    .select('device_hash')
    .where('app_id', '=', appId)
    .where('id', '=', deviceId)
    .executeTakeFirst();
  return row?.device_hash;
}
