// Read-only access to app.realname (规划/08 BR-ID-25, BR-ID-26; task B1-13d §9.2 #5, #7). identity is
// the only writer of the table (application/realname.ts); other modules read through these ports
// only, from identity's index.ts.
// - read(): realname_status of the user's row (none when there is no row). Stage ⑨ of the request
//   decision order (identity-level.ts), GET /v1/me and the identity level use it.
// - verified(): the decrypted name and birth date of a verified record, for growth (age, BR-ID-26)
//   and the labour agreement; null unless the row is verified. Never an HTTP response: callers
//   must not log or return the name or the birth date.
// Both use the caller's handle (a transaction included), uncached, and never write. The FieldCrypto
// domains (contexts) are the ones the writer uses (REALNAME_CONTEXT).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { FieldCrypto } from '../../platform/index.ts';
import type { RealnameStatus, RealnameStatusReader } from '../application/identity-level.ts';

/** FieldCrypto contexts of the realname columns (encryption domains, also of the blind index). */
export const REALNAME_CONTEXT = Object.freeze({
  name: 'realname.name',
  idNo: 'realname.id_no',
  birthDate: 'realname.birth_date',
});

/** Internal read-only projection for growth and labor agreements; never an HTTP response. */
export interface VerifiedRealname {
  readonly name: string;
  readonly birth_date: string;
  readonly provider: string;
  readonly verified_at: Date;
}

export interface RealnameReader extends RealnameStatusReader {
  verified(
    handle: Kysely<DB>,
    subject: { readonly app_id: string; readonly user_id: string },
  ): Promise<VerifiedRealname | null>;
}

const STATUSES: ReadonlySet<string> = new Set(['none', 'verified', 'failed']);

/** realname_status only; needs no field cipher (stage ⑨ and GET /v1/me). */
export function createRealnameStatusReader(): RealnameStatusReader {
  return Object.freeze({
    async read(handle: Kysely<DB>, subject: { readonly app_id: string; readonly user_id: string }) {
      const row = await handle
        .withSchema('app')
        .selectFrom('realname')
        .select('status')
        .where('app_id', '=', subject.app_id)
        .where('user_id', '=', subject.user_id)
        .executeTakeFirst();
      if (row === undefined) return 'none';
      // The column has a CHECK; anything else is a broken database, never "not verified".
      if (!STATUSES.has(row.status)) throw new Error('identity: unknown realname status');
      return row.status as RealnameStatus;
    },
  });
}

/** Uses the caller's handle, including a transaction; no cache and no writes. */
export function createRealnameReader(crypto: FieldCrypto): RealnameReader {
  const status = createRealnameStatusReader();
  return Object.freeze({
    read: status.read,
    async verified(
      handle: Kysely<DB>,
      subject: { readonly app_id: string; readonly user_id: string },
    ): Promise<VerifiedRealname | null> {
      const row = await handle
        .withSchema('app')
        .selectFrom('realname')
        .select(['name_cipher', 'birth_date_cipher', 'provider', 'verified_at'])
        .where('app_id', '=', subject.app_id)
        .where('user_id', '=', subject.user_id)
        .where('status', '=', 'verified')
        .executeTakeFirst();
      if (row === undefined) return null;
      const { name_cipher, birth_date_cipher, provider, verified_at } = row;
      // realname_verified_check guarantees these on a verified row.
      if (
        name_cipher === null ||
        birth_date_cipher === null ||
        provider === null ||
        verified_at === null
      ) {
        throw new Error('identity: incomplete verified realname record');
      }
      return {
        name: crypto.decrypt(Buffer.from(name_cipher).toString('utf8'), REALNAME_CONTEXT.name),
        birth_date: crypto.decrypt(
          Buffer.from(birth_date_cipher).toString('utf8'),
          REALNAME_CONTEXT.birthDate,
        ),
        provider,
        verified_at,
      };
    },
  });
}
