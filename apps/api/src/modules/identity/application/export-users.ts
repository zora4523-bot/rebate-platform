// identity's projection of the console users list for admin's export worker (B1-34e; BR-ID-42,
// BR-ID-33). The rows and columns of GET /admin/v1/users (list view) for one page: app-scoped,
// optional risk_state filter (no risk row reads as normal), ordered created_at desc, id desc.
// Paging: page / pageSize (OFFSET) for a single read; a full walk passes back each page's opaque
// `next` cursor as `after` (keyset on (created_at, id); page is then not used for an offset)
// and a fixed `createdUpTo` bound, so users registering during the walk neither shift rows into
// a second page (duplicates) nor push rows out of it (omissions). The
// phone cipher is decrypted here in one pass over the page (no per-user read) and, unless the
// caller asks for masked=false, masked at once (BR-ID-33 3+4); a broken cipher fails the whole
// page closed — no cipher text and no partial plaintext ever leaves identity. No writes, no logs.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
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
  /** Only users created at or before this instant (the export's start, from the injected Clock). */
  readonly createdUpTo?: Date;
  /** The previous page's `next`: keyset continuation; when given, `page` does not offset. */
  readonly after?: string;
  /** Omission means masked. Only an already-authorized persisted task may request false. */
  readonly masked?: boolean;
}

export interface ExportUsersReader {
  page(input: ExportUsersQuery): Promise<{
    readonly items: readonly ExportUserRow[];
    readonly total: number;
    /** Keyset cursor after the last item (null on an empty page); opaque, no personal data. */
    readonly next?: string | null;
  }>;
}

/** Cursor: created_at with microseconds (UTC) and id; timestamptz keeps microseconds. */
const CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

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
      if (input.createdUpTo !== undefined && Number.isNaN(input.createdUpTo.getTime())) {
        throw new RangeError('identity: export upper bound must be a valid instant');
      }
      const cursor = input.after === undefined ? undefined : CURSOR.exec(input.after);
      if (cursor === null) throw new RangeError('identity: export cursor is invalid');
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
      if (input.createdUpTo !== undefined) {
        query = query.where('users.created_at', '<=', input.createdUpTo);
      }
      const count = await query
        .select((eb) => eb.fn.countAll<bigint>().as('total'))
        .executeTakeFirstOrThrow();
      let rowsQuery = query;
      if (cursor !== undefined) {
        rowsQuery = rowsQuery.where(
          sql<boolean>`(users.created_at, users.id) < (${cursor[1]}::timestamptz, ${cursor[2]}::uuid)`,
        );
      }
      const rows = await rowsQuery
        .select([
          'users.id',
          'users.nickname',
          'users.level',
          'users.created_at',
          'users.phone_cipher',
          'risk.state as risk_state',
          sql<string>`to_char(users.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
            'cursor_at',
          ),
        ])
        .orderBy('users.created_at', 'desc')
        .orderBy('users.id', 'desc')
        .limit(input.pageSize)
        .offset(cursor === undefined ? (input.page - 1) * input.pageSize : 0)
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
      const last = rows.at(-1);
      return {
        items,
        total: Number(count.total),
        next: last === undefined ? null : `${last.cursor_at}|${last.id}`,
      };
    },
  });
}
