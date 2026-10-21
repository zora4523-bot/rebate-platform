// B1-10j: the SQL of the console's claim review reads (tables claims, claim_items and orders, all
// owned by orders). Read only, on the pool handle, always scoped by app_id and naming schema app.
// q has no index of its own: the claims of one app are few, a scan is accepted (an index would be
// a migration task of its own).
import type { DB } from '@couli/db';
import { sql, type ExpressionBuilder, type Kysely } from 'kysely';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The list filters (q already normalised; status kept apart, it never limits the counts). */
export interface AdminClaimFilter {
  readonly appId: string;
  readonly platform?: string;
  readonly evidenceLevel?: string;
  readonly userId?: string;
  readonly q?: string;
}

/** A claims row as the console reads it. */
export interface AdminClaimRow {
  readonly id: string;
  readonly user_id: string;
  readonly platform: string;
  readonly order_no: string;
  readonly order_no_type: string;
  readonly paid_day: string;
  readonly evidence_level: string | null;
  readonly status: string;
  readonly reason: string | null;
  readonly created_at: Date;
}

/** A claim_items row with the comparison columns of its orders row (null when missing). */
export interface AdminClaimItemRow {
  readonly id: string;
  readonly sub_order_id: string;
  readonly evidence: string | null;
  readonly evidence_link_log_ids: bigint[] | null;
  readonly decision: string | null;
  readonly reject_reason: string | null;
  readonly decided_by: string | null;
  readonly decided_at: Date | null;
  readonly row_version: number;
  readonly order_sub_order_id: string | null;
  readonly parent_order_id: string | null;
  readonly is_presale: boolean | null;
  readonly deposit_paid_at: Date | null;
  readonly paid_at: Date | null;
}

export interface AdminClaimReads {
  /** (status, n) for every status the filters (status excluded) match. */
  counts(filter: AdminClaimFilter): Promise<{ status: string; n: number }[]>;
  /** One page: auto_matched first, then created_at, id descending. */
  page(
    filter: AdminClaimFilter,
    status: string | undefined,
    offset: number,
    limit: number,
  ): Promise<AdminClaimRow[]>;
  /** One claim of the app, or undefined. `claimId` must be a UUID. */
  claim(appId: string, claimId: string): Promise<AdminClaimRow | undefined>;
  /** The claim's child orders, created_at then id ascending. */
  items(appId: string, claimId: string): Promise<AdminClaimItemRow[]>;
}

type ClaimsScope = ExpressionBuilder<DB, 'claims'>;

function where(eb: ClaimsScope, filter: AdminClaimFilter) {
  const conditions = [eb('claims.app_id', '=', filter.appId)];
  if (filter.platform !== undefined) conditions.push(eb('claims.platform', '=', filter.platform));
  if (filter.evidenceLevel !== undefined) {
    conditions.push(eb('claims.evidence_level', '=', filter.evidenceLevel));
  }
  if (filter.userId !== undefined) conditions.push(eb('claims.user_id', '=', filter.userId));
  if (filter.q !== undefined) {
    const q = filter.q;
    const anyOf = [
      eb('claims.order_no', '=', q),
      eb.exists(
        eb
          .selectFrom('claim_items')
          .select(sql<number>`1`.as('one'))
          .whereRef('claim_items.app_id', '=', 'claims.app_id')
          .whereRef('claim_items.claim_id', '=', 'claims.id')
          .where('claim_items.sub_order_id', '=', q),
      ),
    ];
    // claims.id is a uuid: only a UUID-shaped q can name a claim (no cast error, no prefix match).
    if (UUID.test(q)) anyOf.push(eb('claims.id', '=', q.toLowerCase()));
    conditions.push(eb.or(anyOf));
  }
  return eb.and(conditions);
}

const CLAIM_COLUMNS = [
  'claims.id',
  'claims.user_id',
  'claims.platform',
  'claims.order_no',
  'claims.order_no_type',
  'claims.evidence_level',
  'claims.status',
  'claims.reason',
  'claims.created_at',
] as const;

export function createAdminClaimReads(database: Kysely<DB>): AdminClaimReads {
  const db = database.withSchema('app');
  const paidDay = sql<string>`to_char(${sql.ref('claims.paid_date')}, 'YYYY-MM-DD')`.as('paid_day');
  return {
    async counts(filter) {
      return db
        .selectFrom('claims')
        .select(['claims.status', sql<number>`count(*)::int`.as('n')])
        .where((eb) => where(eb, filter))
        .groupBy('claims.status')
        .execute();
    },

    async page(filter, status, offset, limit) {
      let query = db
        .selectFrom('claims')
        .select([...CLAIM_COLUMNS, paidDay])
        .where((eb) => where(eb, filter));
      if (status !== undefined) query = query.where('claims.status', '=', status);
      return query
        .orderBy(sql`(${sql.ref('claims.status')} = 'auto_matched')`, 'desc')
        .orderBy('claims.created_at', 'desc')
        .orderBy('claims.id', 'desc')
        .offset(offset)
        .limit(limit)
        .execute();
    },

    async claim(appId, claimId) {
      return db
        .selectFrom('claims')
        .select([...CLAIM_COLUMNS, paidDay])
        .where('claims.app_id', '=', appId)
        .where('claims.id', '=', claimId)
        .executeTakeFirst();
    },

    async items(appId, claimId) {
      return db
        .selectFrom('claim_items')
        .leftJoin('orders', (join) =>
          join
            .onRef('orders.app_id', '=', 'claim_items.app_id')
            .onRef('orders.order_id', '=', 'claim_items.order_id'),
        )
        .select([
          'claim_items.id',
          'claim_items.sub_order_id',
          'claim_items.evidence',
          'claim_items.evidence_link_log_ids',
          'claim_items.decision',
          'claim_items.reject_reason',
          'claim_items.decided_by',
          'claim_items.decided_at',
          'claim_items.row_version',
          'orders.sub_order_id as order_sub_order_id',
          'orders.parent_order_id',
          'orders.is_presale',
          'orders.deposit_paid_at',
          'orders.paid_at',
        ])
        .where('claim_items.app_id', '=', appId)
        .where('claim_items.claim_id', '=', claimId)
        .orderBy('claim_items.created_at', 'asc')
        .orderBy('claim_items.id', 'asc')
        .execute();
    },
  };
}
