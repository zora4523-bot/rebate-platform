// app.login_logs (04 §3.2): insert-only, written only by identity (规划/02 §4.1). Every function
// runs in the caller's transaction; nothing here commits.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface NewLoginLog {
  readonly app_id: string;
  readonly user_id: string;
  /** HMAC of the device_id (LOGIN_LOGS_DEVICE_ID_CONTEXT), never the plain id. */
  readonly device_id_hash: string;
  /**
   * devices.device_hash of the verified device row the login ran on (BR-ID-37 同设备多账号);
   * null only when that row is missing.
   */
  readonly device_hash: string | null;
  readonly ip: string;
  readonly method: string;
  readonly created_at: Date;
}

/** Whether the user has any login_logs row yet (BR-INV-09 first App login). */
export async function hasLoginLog(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('login_logs')
    .select('id')
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export async function insertLoginLog(trx: Transaction<DB>, log: NewLoginLog): Promise<void> {
  await trx
    .insertInto('login_logs')
    .values({ ...log })
    .execute();
}
