// identity's reads for the console's user operations (F1-07a). Always filtered by the admin
// actor's app_id and the user_id: a user of another app reads as absent.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { AdminRevealStore } from '../application/admin-user-reveal.ts';

export function createKyselyAdminRevealStore(db: Kysely<DB>): AdminRevealStore {
  return {
    async phoneCipher({ appId, userId }) {
      const row = await db
        .withSchema('app')
        .selectFrom('users')
        .select('phone_cipher')
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .executeTakeFirst();
      return row === undefined ? undefined : { phoneCipher: row.phone_cipher };
    },
  };
}
