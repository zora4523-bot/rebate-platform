import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export async function openUserAccount(
  trx: Transaction<DB>,
  input: { readonly appId: string; readonly userId: string },
): Promise<void> {
  void trx;
  void input;
  throw new Error('NotImplemented: openUserAccount');
}
