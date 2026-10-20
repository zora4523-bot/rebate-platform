import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';

export interface RiskStateBatchInput {
  readonly appId: string;
  readonly userIds: readonly string[];
}

export interface RiskStateBatchValue {
  readonly state: 'normal' | 'frozen' | 'appealing' | 'banned';
  readonly frozen_until: Date | null;
}

export interface RiskStateBatchReaderOptions {
  readonly db: Kysely<DB>;
}

export interface RiskStateBatchReader {
  read(
    executor: Transaction<DB> | Kysely<DB>,
    input: RiskStateBatchInput,
  ): Promise<ReadonlyMap<string, RiskStateBatchValue>>;
}

export function createRiskStateBatchReader(
  options: RiskStateBatchReaderOptions,
): RiskStateBatchReader {
  void options;
  throw new Error('NotImplemented: createRiskStateBatchReader');
}
