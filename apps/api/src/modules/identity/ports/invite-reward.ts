import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface InviteRewardLoginIpsReader {
  read(
    trx: Transaction<DB>,
    input: { app_id: string; user_id: string; from: Date; to: Date },
  ): Promise<readonly string[]>;
}

/** Canonical host(ip), scoped to [from, to), successful retained logins only. */
export function createInviteRewardLoginIpsReader(): InviteRewardLoginIpsReader {
  throw new Error('NotImplemented: createInviteRewardLoginIpsReader');
}

export interface InviteRewardDeletedPhoneReader {
  retained(
    trx: Transaction<DB>,
    input: { app_id: string; user_id: string; at: Date },
  ): Promise<boolean>;
}

/** Match the user's phone HMAC against either retained deletion reason, expire_at > at. */
export function createInviteRewardDeletedPhoneReader(): InviteRewardDeletedPhoneReader {
  throw new Error('NotImplemented: createInviteRewardDeletedPhoneReader');
}
