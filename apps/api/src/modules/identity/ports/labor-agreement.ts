import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** Read-only withdrawal prerequisite; equivalent to GET need_sign=false, scoped to the app/user. */
export async function laborAgreementSigned(
  handle: Kysely<DB>,
  subject: { readonly app_id: string; readonly user_id: string },
): Promise<boolean> {
  void handle;
  void subject;
  throw new Error('NotImplemented: laborAgreementSigned');
}
