import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';

export type UserDeletionStatus = 'none' | 'processing' | 'done';

export interface UserDeletionStatusInput {
  app_id: string;
  user_ids: readonly string[];
}

export interface UserDeletionStatusReader {
  read(
    executor: Kysely<DB> | Transaction<DB>,
    input: UserDeletionStatusInput,
  ): Promise<ReadonlyMap<string, UserDeletionStatus>>;
}

export interface UserDeletionStatusReaderOptions {
  db: Kysely<DB>;
}

// B1-02ze: read only through the caller's executor, including uncommitted changes.
// users.status: deleting → processing, deleted → done, otherwise → none; absent IDs are omitted.
// TODO(规划/11 §4.5): 读注销单 deletion_requests 的 processing / done — blocked on B1-15
export function createUserDeletionStatusReader(
  options: UserDeletionStatusReaderOptions,
): UserDeletionStatusReader {
  void options;
  throw new Error('NotImplemented: createUserDeletionStatusReader');
}
