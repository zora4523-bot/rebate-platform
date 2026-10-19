// The user's current labor_agreement record (规划/08 BR-WDR-31, BR-ID-12; task B1-13h §9.2). Read-only,
// uncached, always on the caller's handle (a transaction included, also a READ ONLY one), never a
// second pooled connection. The agreement's configuration is not read here: it comes through the
// assembled LaborAgreementConfigReader (ports/labor-agreement.ts), content being config_items' owner.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { LaborAgreementRecord } from '../domain/labor-agreement.ts';

/** The user's current user-level labor_agreement record: latest server_at, then the largest id. */
export async function currentLaborAgreementRecord(
  handle: Kysely<DB>,
  subject: { readonly app_id: string; readonly user_id: string },
): Promise<LaborAgreementRecord | undefined> {
  return handle
    .withSchema('app')
    .selectFrom('consent_records')
    .select(['version', 'accepted', 'server_at'])
    .where('app_id', '=', subject.app_id)
    .where('subject_type', '=', 'user')
    .where('user_id', '=', subject.user_id)
    .where('type', '=', 'labor_agreement')
    .orderBy('server_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
}
