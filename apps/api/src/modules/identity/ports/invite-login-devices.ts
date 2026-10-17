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
  throw new Error('NotImplemented: createInviteLoginDevicesReader');
}
