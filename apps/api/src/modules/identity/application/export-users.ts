// identity's projection of the console users list for admin's export worker (B1-34e; BR-ID-42,
// BR-ID-33). The rows and columns of GET /admin/v1/users (list view) for one page: app-scoped,
// optional risk_state filter (no risk row reads as normal), ordered created_at desc, id desc. The
// phone cipher is decrypted here in one pass over the page (no per-user read) and, unless the
// caller asks for masked=false, masked at once (BR-ID-33 3+4); a broken cipher fails the whole
// page closed — no cipher text and no partial plaintext ever leaves identity. No writes, no logs.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { FieldCrypto } from '../../platform/index.ts';
import { maskPhone } from '../domain/mask-phone.ts';
import { PHONE_CIPHER_CONTEXT } from '../domain/registration.ts';

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
  const db = options.db.withSchema('app');
  const { crypto } = options;
  return Object.freeze({
    async page(input: ExportUsersQuery) {
      const { appId, riskState } = input;
      const masked = input.masked !== false;
      if (!Number.isSafeInteger(input.page) || input.page < 1) {
        throw new RangeError('identity: export page must be a positive integer');
      }
      if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1) {
        throw new RangeError('identity: export page size must be a positive integer');
      }
      let query = db
        .selectFrom('users')
        .leftJoin('user_risk_state as risk', (join) =>
          join.onRef('risk.user_id', '=', 'users.id').on('risk.app_id', '=', appId),
        )
        .where('users.app_id', '=', appId);
      if (riskState !== undefined) {
        query = query.where((eb) =>
          riskState === 'normal'
            ? eb.or([eb('risk.state', '=', 'normal'), eb('risk.user_id', 'is', null)])
            : eb('risk.state', '=', riskState),
        );
      }
      const count = await query
        .select((eb) => eb.fn.countAll<bigint>().as('total'))
        .executeTakeFirstOrThrow();
      const rows = await query
        .select([
          'users.id',
          'users.nickname',
          'users.level',
          'users.created_at',
          'users.phone_cipher',
          'risk.state as risk_state',
        ])
        .orderBy('users.created_at', 'desc')
        .orderBy('users.id', 'desc')
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize)
        .execute();
      // Decrypt the whole page before building any row: one failure rejects the page.
      const items = rows.map((row): ExportUserRow => {
        let phone: string | null = null;
        if (row.phone_cipher !== null) {
          const plain = crypto.decrypt(
            Buffer.from(row.phone_cipher).toString('utf8'),
            PHONE_CIPHER_CONTEXT,
          );
          phone = masked ? maskPhone(plain) : plain;
        }
        return {
          user_id: row.id,
          nickname: row.nickname,
          phone,
          level: row.level as Schema<'AdminUserLevel'>,
          risk_state: (row.risk_state ?? 'normal') as Schema<'AdminUserRiskStateCode'>,
          created_at: row.created_at.toISOString(),
        };
      });
      return { items, total: Number(count.total) };
    },
  });
}
