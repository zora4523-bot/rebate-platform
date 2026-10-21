// Identity's read-only ports for growth's invite reward payout (task B1-35 §9.2 第 6 条; 08 BR-INV-24
// ③): the inviter's login IPs in the window before the binding (login_logs.ip, the gateway's client
// IP, as host() canonical text so growth can blind-index it the way it stored the bind IP), and
// whether the invitee's current phone hits an unexpired retained identity (BR-ID-28, BR-ID-06).
// Each runs one SELECT on the caller's transaction; no writes, no locks, no logging.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';

export interface InviteRewardLoginIpsReader {
  read(
    trx: Transaction<DB>,
    input: { app_id: string; user_id: string; from: Date; to: Date },
  ): Promise<readonly string[]>;
}

/** Canonical host(ip), scoped to [from, to), successful retained logins only. */
export function createInviteRewardLoginIpsReader(): InviteRewardLoginIpsReader {
  return {
    async read(trx, input) {
      const rows = await trx
        .withSchema('app')
        .selectFrom('login_logs')
        .select(sql<string>`host(${sql.ref('ip')}::inet)`.as('host'))
        .distinct()
        .where('app_id', '=', input.app_id)
        .where('user_id', '=', input.user_id)
        .where('created_at', '>=', input.from)
        .where('created_at', '<', input.to)
        .orderBy('host')
        .execute();
      return rows.map((row) => row.host);
    },
  };
}

export interface InviteRewardDeletedPhoneReader {
  retained(
    trx: Transaction<DB>,
    input: { app_id: string; user_id: string; at: Date },
  ): Promise<boolean>;
}

/** Match the user's phone HMAC against either retained deletion reason, expire_at > at. */
export function createInviteRewardDeletedPhoneReader(): InviteRewardDeletedPhoneReader {
  return {
    async retained(trx, input) {
      const row = await trx
        .withSchema('app')
        .selectFrom('deleted_identities as d')
        .innerJoin('users as u', (join) =>
          join.onRef('u.app_id', '=', 'd.app_id').onRef('u.phone_hmac', '=', 'd.phone_hmac'),
        )
        .select('d.id')
        .where('d.app_id', '=', input.app_id)
        .where('u.id', '=', input.user_id)
        .where('d.expire_at', '>', input.at)
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}
