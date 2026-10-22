import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { FieldCrypto } from '../../platform/index.ts';

/** Internal export projection; phone contains the requested masked/full representation. */
export interface ExportUserRow {
  readonly user_id: string;
  readonly nickname: string;
  readonly phone: string | null;
  readonly level: Schema<'AdminUserLevel'>;
  readonly risk_state: Schema<'AdminUserRiskStateCode'>;
  readonly created_at: string;
}

export interface ExportUsersQuery {
  readonly appId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly riskState?: Schema<'AdminUserRiskStateCode'>;
  /** Omission means masked. Only an already-authorized persisted task may request false. */
  readonly masked?: boolean;
}

export interface ExportUsersReader {
  page(input: ExportUsersQuery): Promise<{
    readonly items: readonly ExportUserRow[];
    readonly total: number;
  }>;
}

/** Batch database projection and decryption stay inside identity. */
export function createExportUsersReader(options: {
  readonly db: Kysely<DB>;
  readonly crypto: FieldCrypto;
}): ExportUsersReader {
  void options;
  throw new Error('NotImplemented: createExportUsersReader');
}
