// B1-10j: identity's read-only port of the applicants' masked phone numbers for the console's claim
// review (orders: GET /admin/v1/claims and /admin/v1/claims/{claim_id}; BR-ID-33 手机号 3+4).
// One statement over app.users by app_id and id = ANY(deduplicated ids); the cipher is decrypted
// here and masked at once, so only the masked string leaves identity (orders never reads identity's
// tables and never sees the plaintext). A user without a phone, or with no row of this app, reads as
// null. No locks, no writes, no logging.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { FieldCrypto } from '../../platform/index.ts';
import { maskPhone } from '../domain/mask-phone.ts';
import { PHONE_CIPHER_CONTEXT } from '../domain/registration.ts';

export interface MaskedPhoneReader {
  /** user_id → masked phone (138****5678), or null without a phone; absent ids read as null too. */
  maskedPhones(
    appId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>>;
}

/** Without the field cipher a user with a phone fails closed (the route answers 50001). */
export function createMaskedPhoneReader(
  db: Kysely<DB>,
  crypto: FieldCrypto | null,
): MaskedPhoneReader {
  return Object.freeze({
    async maskedPhones(appId: string, userIds: readonly string[]) {
      const ids = [...new Set(userIds)];
      const result = new Map<string, string | null>();
      if (ids.length === 0) return result;
      const rows = await db
        .withSchema('app')
        .selectFrom('users')
        .select(['id', 'phone_cipher'])
        .where('app_id', '=', appId)
        .where('id', '=', sql<string>`ANY(${ids}::uuid[])`)
        .execute();
      for (const row of rows) {
        if (row.phone_cipher === null) {
          result.set(row.id, null);
          continue;
        }
        if (crypto === null) throw new Error('identity: masked phones need the field cipher');
        const phone = crypto.decrypt(
          Buffer.from(row.phone_cipher).toString('utf8'),
          PHONE_CIPHER_CONTEXT,
        );
        result.set(row.id, maskPhone(phone));
      }
      return result;
    },
  });
}
