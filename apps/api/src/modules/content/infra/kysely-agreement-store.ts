// F1-02n: SELECT-only reads of app.agreements (writer: content, F1-02p). The current version of
// a type is its largest version (unique (app_id, type, version) serves the ORDER BY ... LIMIT 1).
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { AgreementType } from '../domain/agreements/index.ts';

export interface CurrentAgreementRow {
  readonly version: number;
  readonly min_version: number;
  readonly url: string;
  readonly text_sha256: string;
  readonly published_at: Date;
}

export interface PublicAgreementRow {
  readonly type: string;
  readonly version: number;
  readonly min_version: number;
  readonly article_id: string;
  readonly article_version: number;
  readonly text_sha256: string;
  readonly url: string;
  readonly published_at: string;
}

/** Exactly one statement; `db` may be the caller's transaction. */
export async function currentAgreementRow(
  db: Kysely<DB>,
  appId: string,
  type: AgreementType,
): Promise<CurrentAgreementRow | null> {
  const row = await db
    .withSchema('app')
    .selectFrom('agreements')
    .select(['version', 'min_version', 'url', 'text_sha256', 'published_at'])
    .where('app_id', '=', appId)
    .where('type', '=', type)
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ?? null; // pg parses timestamptz into Date
}

/** The current row of each listed type in one statement (types without a row are absent). */
export async function currentAgreementRows(
  db: Kysely<DB>,
  appId: string,
  types: readonly AgreementType[],
): Promise<readonly PublicAgreementRow[]> {
  return db
    .withSchema('app')
    .selectFrom('agreements as g')
    .distinctOn('g.type')
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
    .where('g.type', 'in', [...types])
    .orderBy('g.type')
    .orderBy('g.version', 'desc')
    .execute();
}
