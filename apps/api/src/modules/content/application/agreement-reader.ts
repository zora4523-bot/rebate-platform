// F1-02n: agreement reads (04 §6.2 agreements; L6 / L8 / L11).
// - createAgreementReader: the port identity uses when deciding and recording a signature. One
//   indexed query per call, never cached, so a version published a moment ago is seen at once;
//   `db` may be the caller's transaction. No row → null (never invented; the caller answers 50001).
// - PublicAgreementReader: GET /v1/agreements (privacy and user agreement only), cached per app_id
//   for CONTENT_CACHE_TTL_MS on the injected Clock like the other public content reads.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { resignFromVersion, type AgreementType } from '../domain/agreements/index.ts';
import { CONTENT_CACHE_TTL_MS } from '../domain/cache-policy.ts';
import {
  currentAgreementRow,
  currentAgreementRows,
  type PublicAgreementRow,
} from '../infra/kysely-agreement-store.ts';
import { TtlCache } from './ttl-cache.ts';

export interface CurrentAgreement {
  readonly version: number;
  readonly min_version: number;
  readonly resign_from_version: number;
  readonly text_url: string;
  readonly text_sha256: string;
  readonly published_at: Date;
}

export interface AgreementReader {
  currentAgreement(appId: string, type: AgreementType): Promise<CurrentAgreement | null>;
}

export interface AgreementReaderOptions {
  /** Accepts either the primary database handle or the caller's Kysely transaction. */
  readonly db: Kysely<DB>;
}

export function createAgreementReader(options: AgreementReaderOptions): AgreementReader {
  const { db } = options;
  return {
    async currentAgreement(appId, type) {
      const row = await currentAgreementRow(db, appId, type);
      if (row === null) return null;
      return {
        version: row.version,
        min_version: row.min_version,
        resign_from_version: resignFromVersion(row),
        text_url: row.url,
        text_sha256: row.text_sha256,
        published_at: row.published_at,
      };
    },
  };
}

export type AgreementsData = Schema<'AgreementsData'>;
type PublicType = Schema<'PublicAgreement'>['type'];

/** Source of the current privacy / agreement rows of one app (absent type: never published). */
export type PublicAgreementSource = (appId: string) => Promise<readonly PublicAgreementRow[]>;

export function kyselyPublicAgreementSource(db: Kysely<DB>): PublicAgreementSource {
  return (appId) => currentAgreementRows(db, appId, ['privacy', 'agreement']);
}

function toPublic(rows: readonly PublicAgreementRow[], type: PublicType) {
  const row = rows.find((candidate) => candidate.type === type);
  if (row === undefined) return null;
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

export class PublicAgreementReader {
  readonly #source: PublicAgreementSource | null;
  readonly #cache: TtlCache<AgreementsData>;

  /** `source` null: no database handle; every read rejects (50001). */
  constructor(source: PublicAgreementSource | null, clock: Clock) {
    this.#source = source;
    this.#cache = new TtlCache(clock, CONTENT_CACHE_TTL_MS);
  }

  read(appId: string): Promise<AgreementsData> {
    const source = this.#source;
    if (source === null) {
      return Promise.reject(new Error('content: agreement reads need the database'));
    }
    return this.#cache.get(appId, async () => {
      const rows = await source(appId);
      return { privacy: toPublic(rows, 'privacy'), agreement: toPublic(rows, 'agreement') };
    });
  }
}
