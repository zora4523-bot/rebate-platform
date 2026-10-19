// F1-02ze: GET /v1/agreements/{type} (getAgreementVersion). One indexed query per request and no
// cross-request cache, so a version published a moment ago is seen at once and history is read
// as stored. Read only: no consent, audit or agreement row is written here.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { AgreementType } from '../domain/agreements/index.ts';
import type { PublicAgreementRow } from '../infra/kysely-agreement-store.ts';
import { agreementVersionRow } from '../infra/kysely-agreement-version-store.ts';

export type PublicAgreementVersion = Schema<'PublicAgreementVersion'>;

/** One row of the app's agreements by type and version (null version: the current one). */
export type AgreementVersionSource = (
  appId: string,
  type: AgreementType,
  version: number | null,
) => Promise<PublicAgreementRow | null>;

export function kyselyAgreementVersionSource(db: Kysely<DB>): AgreementVersionSource {
  return (appId, type, version) => agreementVersionRow(db, appId, type, version);
}

export class AgreementVersionReader {
  readonly #source: AgreementVersionSource | null;

  /** `source` null: no database handle; every read rejects (50001). */
  constructor(source: AgreementVersionSource | null) {
    this.#source = source;
  }

  async read(
    appId: string,
    type: AgreementType,
    version: number | null,
  ): Promise<PublicAgreementVersion | null> {
    const source = this.#source;
    if (source === null) throw new Error('content: agreement reads need the database');
    const row = await source(appId, type, version);
    if (row === null) return null;
    // Exactly the eight contract fields, whatever else the source carries.
    return {
      type,
      version: row.version,
      min_version: row.min_version,
      article_id: row.article_id,
      article_version: row.article_version,
      text_sha256: row.text_sha256,
      url: row.url,
      published_at: row.published_at,
    };
  }
}
