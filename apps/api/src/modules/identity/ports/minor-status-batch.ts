// Identity's batch minor-status reader (规划/08 BR-ID-26; task B1-03zc, D10-443 (b)), for settlement's
// BeneficiaryGate MinorStatusReader: the users of the given app whose realname row is verified,
// identified (verified_at) no later than `at`, and under 18 at `at` by the decrypted birth_date.
// Runs on the caller's executor; no locks, no writes, no cache, no logging, no birth date returned.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { FieldCrypto } from '../../platform/index.ts';

export interface MinorStatusBatchInput {
  readonly appId: string;
  readonly userIds: readonly string[];
  /** The instant of the check (the caller's transaction time). */
  readonly at: Date;
}

export interface MinorStatusBatchReaderOptions {
  readonly crypto: FieldCrypto;
}

export interface MinorStatusBatchReader {
  read(
    executor: Transaction<DB> | Kysely<DB>,
    input: MinorStatusBatchInput,
  ): Promise<ReadonlySet<string>>;
}

export function createMinorStatusBatchReader(
  options: MinorStatusBatchReaderOptions,
): MinorStatusBatchReader {
  void options;
  throw new Error('NotImplemented: createMinorStatusBatchReader');
}
