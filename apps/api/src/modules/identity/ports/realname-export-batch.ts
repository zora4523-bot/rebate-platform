// B2-08e (规划/08 BR-WDR-21; 编排裁定 D10-544): identity's read-only batch port of the real names for
// the quarterly tax export. One statement on the caller's executor over app.realname by app_id and
// user_id = ANY(deduplicated ids); no locks, no writes, no logging, no cache.
//
// Readable records: status verified, and a deleted user's record kept for tax (tax_retained, status
// none, ciphers kept; BR-WDR-21 细则 涉税记录保留). Any other user is simply absent from the map: no
// row, a failed attempt, a cleared record. The caller decides what that means (the tax export fails
// the whole task). A cipher that does not decrypt throws, and the error carries no value.
//
// correctedAfter(paidAt): the identity is the user's current one (agent default, D10-544), so a
// payment made before a real-name correction needs that correction's instant beside it. A
// correction overwrites the row in place and sets verified_at to its instant (B1-27a), and no
// withdrawal can be paid before the first verification, so verified_at later than paid_at means
// the current identity was corrected in after that payment (the same reading as
// payout-bank-card.ts's recordsFrom). With several corrections it is the latest one, the one that
// produced the identity in the file. app.realname_prior_identities is not read: couli_app may only
// insert there (B1-27d).
//
// The name and the ID number leave here in clear on purpose, for the export file only: callers must
// not log, store or return them anywhere else.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { FieldCrypto } from '../../platform/index.ts';
import { REALNAME_CONTEXT } from '../infra/realname-reader.ts';

export interface RealnameExportBatchInput {
  readonly appId: string;
  readonly userIds: readonly string[];
}

export interface RealnameExportIdentity {
  readonly name: string;
  readonly id_no: string;
  /** The instant of the correction made after `paidAt`, or null when there was none. */
  correctedAfter(paidAt: Date): Date | null;
}

export interface RealnameExportBatchReaderOptions {
  readonly crypto: FieldCrypto;
}

export interface RealnameExportBatchReader {
  /** user_id → current identity; a user without a readable record is absent. */
  read(
    executor: Transaction<DB> | Kysely<DB>,
    input: RealnameExportBatchInput,
  ): Promise<ReadonlyMap<string, RealnameExportIdentity>>;
}

export function createRealnameExportBatchReader(
  options: RealnameExportBatchReaderOptions,
): RealnameExportBatchReader {
  const { crypto } = options;
  const decrypt = (cipher: Uint8Array, context: string): string =>
    crypto.decrypt(Buffer.from(cipher).toString('utf8'), context);
  return Object.freeze({
    async read(executor: Transaction<DB> | Kysely<DB>, input: RealnameExportBatchInput) {
      const ids = [...new Set(input.userIds)];
      const result = new Map<string, RealnameExportIdentity>();
      if (ids.length === 0) return result;
      const rows = await executor
        .withSchema('app')
        .selectFrom('realname')
        .select(['user_id', 'status', 'tax_retained', 'name_cipher', 'id_no_cipher', 'verified_at'])
        .where('app_id', '=', input.appId)
        .where('user_id', '=', sql<string>`ANY(${ids}::uuid[])`)
        .execute();
      for (const row of rows) {
        if (row.status !== 'verified' && !row.tax_retained) continue;
        if (row.name_cipher === null || row.id_no_cipher === null) continue;
        const verifiedAt = row.verified_at;
        result.set(row.user_id, {
          name: decrypt(row.name_cipher, REALNAME_CONTEXT.name),
          id_no: decrypt(row.id_no_cipher, REALNAME_CONTEXT.idNo),
          correctedAfter: (paidAt) =>
            verifiedAt !== null && verifiedAt.getTime() > paidAt.getTime() ? verifiedAt : null,
        });
      }
      return result;
    },
  });
}
