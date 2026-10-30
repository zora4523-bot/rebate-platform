// Identity's batch minor-status reader (规划/08 BR-ID-26; task B1-03zc, D10-443 (b)), for settlement's
// BeneficiaryGate MinorStatusReader: the users of the given app whose realname row is verified,
// identified (verified_at) no later than `at`, and under 18 at `at` by the decrypted birth_date.
// Runs on the caller's executor; no locks, no writes, no cache, no logging, no birth date returned.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import { isAtLeastAge } from '@couli/domain';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { FieldCrypto } from '../../platform/index.ts';
import { REALNAME_CONTEXT } from '../infra/realname-reader.ts';

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

/** BR-ID-26: the restrictions end at the instant one turns 18 (the 18th birthday's next 00:00 +08:00). */
const ADULT_AGE = 18;

/**
 * Whether the stored birth date makes the user a minor at `at`. A verified row whose cipher is
 * empty, cannot be decrypted or decrypts to an invalid date is a broken database: it throws a
 * fixed message without a cause, so neither the birth date nor the ciphertext leaks into the error.
 */
function isMinorAt(crypto: FieldCrypto, cipher: Uint8Array | null, at: Date): boolean {
  let minor: boolean;
  try {
    if (cipher === null || cipher.length === 0) throw new Error('empty');
    const birth = crypto.decrypt(Buffer.from(cipher).toString('utf8'), REALNAME_CONTEXT.birthDate);
    minor = !isAtLeastAge(birth, ADULT_AGE, at);
  } catch {
    throw new Error('identity: unreadable birth date on a verified realname record');
  }
  return minor;
}

export function createMinorStatusBatchReader(
  options: MinorStatusBatchReaderOptions,
): MinorStatusBatchReader {
  const { crypto } = options;
  return Object.freeze({
    async read(
      executor: Transaction<DB> | Kysely<DB>,
      input: MinorStatusBatchInput,
    ): Promise<ReadonlySet<string>> {
      const ids = [...new Set(input.userIds)];
      const result = new Set<string>();
      if (ids.length === 0) return result;
      const { at } = input;
      if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
        throw new Error('identity: invalid instant for the minor-status read');
      }
      // One statement on the caller's executor: users of this app joined to their own realname
      // row, verified and identified no later than `at`. No locking clause; only the birth date.
      const rows = await executor
        .withSchema('app')
        .selectFrom('users')
        .innerJoin('realname', (join) =>
          join
            .onRef('realname.user_id', '=', 'users.id')
            .onRef('realname.app_id', '=', 'users.app_id'),
        )
        .select(['users.id', 'realname.birth_date_cipher'])
        .where('users.app_id', '=', input.appId)
        .where('users.id', '=', sql<string>`ANY(${ids})`)
        .where('realname.status', '=', 'verified')
        .where('realname.verified_at', '<=', at)
        .execute();
      for (const row of rows) {
        if (isMinorAt(crypto, row.birth_date_cipher, at)) result.add(row.id);
      }
      return result;
    },
  });
}
