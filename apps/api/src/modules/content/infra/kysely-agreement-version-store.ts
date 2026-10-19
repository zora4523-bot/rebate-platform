import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { AgreementType } from '../domain/agreements/index.ts';
import type { PublicAgreementRow } from './kysely-agreement-store.ts';

export async function agreementVersionRow(
  db: Kysely<DB>,
  appId: string,
  type: AgreementType,
  version: number | null,
): Promise<PublicAgreementRow | null> {
  void db;
  void appId;
  void type;
  void version;
  throw new Error('NotImplemented: agreementVersionRow');
}
