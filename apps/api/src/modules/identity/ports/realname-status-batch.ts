import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { RealnameStatus } from '../application/identity-level.ts';

export interface RealnameStatusBatchInput {
  readonly appId: string;
  readonly userIds: readonly string[];
}

export interface RealnameStatusBatchReaderOptions {
  readonly db: Kysely<DB>;
}

export interface RealnameStatusBatchReader {
  read(
    executor: Transaction<DB> | Kysely<DB>,
    input: RealnameStatusBatchInput,
  ): Promise<ReadonlyMap<string, RealnameStatus>>;
}

export function createRealnameStatusBatchReader(
  options: RealnameStatusBatchReaderOptions,
): RealnameStatusBatchReader {
  void options;
  throw new Error('NotImplemented: createRealnameStatusBatchReader');
}
