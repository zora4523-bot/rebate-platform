// Identity's read-only port onto login_logs for growth's same-device check (BR-INV-08 ③, task
// B1-11d §9.3 第 4 项): every retained device_id_hash of one account of one app. login_logs holds
// successful logins only, and retention is the cleanup job's business, so no time window and no
// method filter apply. Reads only through the handle given (the caller's transaction, so its own
// uncommitted rows are visible); nothing is written.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

/** All retained successful login hashes, scoped by app and user; no extra time window. */
export interface InviteLoginDevicesReader {
  read(
    trx: Transaction<DB>,
    subject: { readonly app_id: string; readonly user_id: string },
  ): Promise<readonly string[]>;
}

export function createInviteLoginDevicesReader(): InviteLoginDevicesReader {
  return {
    async read(trx, subject) {
      const rows = await trx
        .withSchema('app')
        .selectFrom('login_logs')
        .select('device_id_hash')
        .distinct()
        .where('app_id', '=', subject.app_id)
        .where('user_id', '=', subject.user_id)
        .execute();
      return rows.map((row) => row.device_id_hash);
    },
  };
}
