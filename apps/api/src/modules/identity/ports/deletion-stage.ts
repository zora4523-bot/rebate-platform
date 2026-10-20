import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';

export type DeletionStage = 'none' | 'cooling' | 'processing' | 'done';

export interface DeletionStageInput {
  appId: string;
  userIds: readonly string[];
}

export interface DeletionStageReader {
  read(
    executor: Kysely<DB> | Transaction<DB>,
    input: DeletionStageInput,
  ): Promise<ReadonlyMap<string, DeletionStage>>;
}

export interface DeletionStageReaderOptions {
  db: Kysely<DB>;
}

export function createDeletionStageReader(
  options: DeletionStageReaderOptions,
): DeletionStageReader {
  void options;
  throw new Error('NotImplemented: createDeletionStageReader');
}
