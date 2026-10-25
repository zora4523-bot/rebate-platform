// Read-only port of an admin account's verify phone (BR-ID-45; B1-12z, orchestrator technical
// decision B.2): the console's SMS registration test send goes to the operator's own verify phone,
// and admin_users belongs to admin (规划/02 §4.1), so app.module hands this reader to
// notification instead of notification reading the table.
//
// read({ appId, adminId }) — admin_users by (app_id, id), every call (no cache, so a number cleared
// after the page was loaded counts at once): the decrypted verify phone, or null when the account
// has none (or does not exist). A cipher that does not decrypt throws (→ 50001); the phone is
// never logged.
//
// Pure module (no decorators, erasable syntax).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { FieldCrypto } from '../../platform/index.ts';
import { verifyPhoneContext } from '../domain/step-up-policy.ts';

export interface AdminVerifyPhoneReader {
  read(account: { readonly appId: string; readonly adminId: string }): Promise<string | null>;
}

export interface AdminVerifyPhoneReaderDeps {
  readonly db: Kysely<DB>;
  readonly crypto: Pick<FieldCrypto, 'decrypt'>;
}

export function createAdminVerifyPhoneReader(
  deps: AdminVerifyPhoneReaderDeps,
): AdminVerifyPhoneReader {
  const db = deps.db.withSchema('app');
  return Object.freeze({
    async read(account: { readonly appId: string; readonly adminId: string }) {
      const row = await db
        .selectFrom('admin_users')
        .select(['verify_phone_cipher'])
        .where('app_id', '=', account.appId)
        .where('id', '=', account.adminId)
        .executeTakeFirst();
      const cipher = row?.verify_phone_cipher ?? null;
      if (cipher === null) return null;
      return deps.crypto.decrypt(cipher.toString('utf8'), verifyPhoneContext(account));
    },
  });
}
