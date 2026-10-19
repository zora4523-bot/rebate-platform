import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { AgreementType } from '../domain/agreements/index.ts';

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
  void options;
  throw new Error('NotImplemented: createAgreementReader');
}
