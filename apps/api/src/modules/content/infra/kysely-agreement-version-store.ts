// F1-02ze: SELECT-only read of one agreement version (writer: content, F1-02p). Without a version
// the current one is the largest version of the type, as in currentAgreementRows; with a version
// the row is matched on (app_id, type, version), the unique key. Exactly one statement per call.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { AgreementType } from '../domain/agreements/index.ts';
import type { PublicAgreementRow } from './kysely-agreement-store.ts';

export async function agreementVersionRow(
  db: Kysely<DB>,
  appId: string,
  type: AgreementType,
  version: number | null,
): Promise<PublicAgreementRow | null> {
  let query = db
    .withSchema('app')
    .selectFrom('agreements as g')
    .select([
      'g.type',
      'g.version',
      'g.min_version',
      'g.article_id',
      'g.article_version',
      'g.text_sha256',
      'g.url',
    ])
    .select(
      sql<string>`to_char(g.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'published_at',
      ),
    )
    .where('g.app_id', '=', appId)
    .where('g.type', '=', type);
  query =
    version === null ? query.orderBy('g.version', 'desc') : query.where('g.version', '=', version);
  const row = await query.limit(1).executeTakeFirst();
  return row ?? null;
}
