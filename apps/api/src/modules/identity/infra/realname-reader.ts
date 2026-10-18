import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { FieldCrypto } from '../../platform/index.ts';
import type { RealnameStatusReader } from '../application/identity-level.ts';

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

/** Uses the caller's handle, including a transaction; no cache and no writes. */
export function createRealnameReader(crypto: FieldCrypto): RealnameReader {
  void crypto;
  throw new Error('NotImplemented: createRealnameReader');
}
