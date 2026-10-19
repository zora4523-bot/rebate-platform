// B1-10b: the SQL of claim acceptance and the claim records (tables claims, claim_items, read of
// orders). Every query runs on the handle it is given (the acceptance transaction, or the pool for
// the record list) and names schema app explicitly.
import type { DB } from '@couli/db';
import { chinaDayRange } from '@couli/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { OrderSubject } from '../application/order-queries.ts';

/** What acceptance reads of a matched orders row. */
export interface ClaimOrderRow {
  readonly order_id: string;
  readonly sub_order_id: string;
  readonly buy_type: string | null;
  readonly user_id: string | null;
  readonly rebate_status: string;
  readonly locked: boolean;
  readonly attr_at: Date;
}

/**
 * Orders of (app_id, platform) whose child (`sub`) or parent (`parent`) number equals `value`.
 * pdd compares with every hyphen removed from the stored number (the caller removes them from the
 * input); other platforms compare exactly. A null parent number never matches.
 */
export async function findClaimOrders(
  trx: Transaction<DB>,
  appId: string,
  platform: string,
  value: string,
  by: 'sub' | 'parent',
): Promise<ClaimOrderRow[]> {
  const column = by === 'sub' ? 'sub_order_id' : 'parent_order_id';
  const stored =
    platform === 'pdd' ? sql<string>`replace(${sql.ref(column)}, '-', '')` : sql.ref(column);
  return trx
    .withSchema('app')
    .selectFrom('orders')
    .select([
      'order_id',
      'sub_order_id',
      'buy_type',
      'user_id',
      'rebate_status',
      'locked',
      'attr_at',
    ])
    .where('app_id', '=', appId)
    .where('platform', '=', platform)
    .where(sql<boolean>`${sql.ref(column)} is not null`)
    .where(sql<boolean>`${stored} = ${value}`)
    .execute();
}

/** Claims of the subject created on the +08:00 day `day` (YYYY-MM-DD), whatever their status. */
export async function countClaimsOn(
  trx: Transaction<DB>,
  subject: OrderSubject,
  day: string,
): Promise<number> {
  const { start, end } = chinaDayRange(day);
  const row = await trx
    .withSchema('app')
    .selectFrom('claims')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('app_id', '=', subject.app_id)
    .where('user_id', '=', subject.user_id)
    .where(sql<boolean>`${sql.ref('created_at')} >= ${start}::timestamptz`)
    .where(sql<boolean>`${sql.ref('created_at')} < ${end}::timestamptz`)
    .executeTakeFirstOrThrow();
  return row.n;
}

/** The sub_order_ids among `subOrderIds` the applicant already has in claim_items (any decision). */
export async function claimedSubOrders(
  trx: Transaction<DB>,
  subject: OrderSubject,
  platform: string,
  subOrderIds: readonly string[],
): Promise<Set<string>> {
  if (subOrderIds.length === 0) return new Set();
  const rows = await trx
    .withSchema('app')
    .selectFrom('claim_items')
    .select('sub_order_id')
    .where('app_id', '=', subject.app_id)
    .where('applicant_user_id', '=', subject.user_id)
    .where('platform', '=', platform)
    .where('sub_order_id', 'in', [...subOrderIds])
    .execute();
  return new Set(rows.map((row) => row.sub_order_id));
}

export interface NewClaim {
  readonly id: string;
  readonly subject: OrderSubject;
  readonly platform: string;
  readonly order_no: string;
  readonly order_no_type: 'sub' | 'parent';
  readonly paid_date: string;
  readonly status: string;
  readonly now: Date;
  readonly items: readonly {
    readonly id: string;
    readonly sub_order_id: string;
    readonly order_id: string;
  }[];
}

/** Inserts the claim and its items; resolves with the status as stored. */
export async function insertClaim(trx: Transaction<DB>, claim: NewClaim): Promise<string> {
  const { subject, now } = claim;
  const saved = await trx
    .withSchema('app')
    .insertInto('claims')
    .values({
      id: claim.id,
      app_id: subject.app_id,
      user_id: subject.user_id,
      platform: claim.platform,
      order_no: claim.order_no,
      order_no_type: claim.order_no_type,
      paid_date: claim.paid_date,
      evidence_level: null,
      status: claim.status,
      created_at: now,
      updated_at: now,
    })
    .returning('status')
    .executeTakeFirstOrThrow();
  await trx
    .withSchema('app')
    .insertInto('claim_items')
    .values(
      claim.items.map((item) => ({
        id: item.id,
        app_id: subject.app_id,
        claim_id: claim.id,
        applicant_user_id: subject.user_id,
        platform: claim.platform,
        sub_order_id: item.sub_order_id,
        order_id: item.order_id,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  return saved.status;
}

/** A claims row as the record list reads it. */
export interface ClaimRecordRow {
  readonly id: string;
  readonly platform: string;
  readonly order_no: string;
  readonly paid_day: string;
  readonly status: string;
  readonly created_at: Date;
  /** created_at as UTC text with microseconds (cursor precision). */
  readonly created_key: string;
}

export interface ClaimItemRow {
  readonly claim_id: string;
  readonly sub_order_id: string;
  readonly decision: string | null;
  readonly reject_reason: string | null;
}

/** The subject's claims, created_at then id descending, strictly after `after` when given. */
export async function listClaimRecords(
  db: Kysely<DB>,
  subject: OrderSubject,
  after: { readonly at: string; readonly id: string } | undefined,
  take: number,
): Promise<ClaimRecordRow[]> {
  let query = db
    .withSchema('app')
    .selectFrom('claims')
    .select([
      'id',
      'platform',
      'order_no',
      'status',
      'created_at',
      sql<string>`to_char(${sql.ref('paid_date')}, 'YYYY-MM-DD')`.as('paid_day'),
      sql<string>`to_char(${sql.ref('created_at')} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'created_key',
      ),
    ])
    .where('app_id', '=', subject.app_id)
    .where('user_id', '=', subject.user_id);
  if (after !== undefined) {
    query = query.where(
      sql<boolean>`(${sql.ref('created_at')}, ${sql.ref('id')}) < (${after.at}::timestamptz, ${after.id}::uuid)`,
    );
  }
  return query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(take).execute();
}

/** Items of the given claims of the subject. */
export async function listClaimItems(
  db: Kysely<DB>,
  subject: OrderSubject,
  claimIds: readonly string[],
): Promise<ClaimItemRow[]> {
  if (claimIds.length === 0) return [];
  return db
    .withSchema('app')
    .selectFrom('claim_items')
    .select(['claim_id', 'sub_order_id', 'decision', 'reject_reason'])
    .where('app_id', '=', subject.app_id)
    .where('applicant_user_id', '=', subject.user_id)
    .where('claim_id', 'in', [...claimIds])
    .execute();
}
