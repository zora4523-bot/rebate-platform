import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface AppealPrevStateReader {
  read(
    handle: Kysely<DB>,
    subject: { appId: string; userId: string },
  ): Promise<'banned' | 'frozen' | null>;
}

export function createAppealPrevStateReader(): AppealPrevStateReader {
  throw new Error('NotImplemented: createAppealPrevStateReader');
}
