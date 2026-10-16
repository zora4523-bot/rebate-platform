import type { UserLevel } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export type { UserLevel } from '@couli/contracts-ts';

export interface UserLevelSubject {
  appId: string;
  userId: string;
}

export interface UserLevelReader {
  levelOf(subject: UserLevelSubject): Promise<UserLevel | null>;
}

export interface UserLevelReaderOptions {
  db: Kysely<DB>;
}

/** B1-02u: uncached, read-only users.level lookup; unknown stored levels must reject. */
export function createUserLevelReader(options: UserLevelReaderOptions): UserLevelReader {
  void options;
  throw new Error('NotImplemented: createUserLevelReader');
}
