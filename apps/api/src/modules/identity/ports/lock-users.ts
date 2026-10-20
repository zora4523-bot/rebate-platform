import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';

export interface LockUsersInput {
  readonly appId: string;
  readonly userIds: readonly string[];
}

export async function lockUsersForUpdate(
  trx: Transaction<DB> | Kysely<DB>,
  input: LockUsersInput,
): Promise<ReadonlySet<string>> {
  void trx;
  void input;
  throw new Error('NotImplemented: lockUsersForUpdate');
}
