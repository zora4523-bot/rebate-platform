import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export async function detachChildrenOfDeleted(
  trx: Transaction<DB>,
  input: { appId: string; userId: string; at: Date },
): Promise<{ detached: number }> {
  void trx;
  void input;
  throw new Error('NotImplemented: detachChildrenOfDeleted');
}
