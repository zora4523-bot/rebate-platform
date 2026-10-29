// SQL of app.recon_diffs for the ledger (its single writer, 04 §3.2). Every statement runs on the
// handle or transaction it is given; reads never lock.
import type { DB } from '@couli/db';
import { sql, type Insertable, type Kysely, type Selectable, type Transaction } from 'kysely';

type ReconDiffRow = Selectable<DB['recon_diffs']>;

export interface ReconDiffInsert extends Omit<Insertable<DB['recon_diffs']>, 'resolution'> {
  readonly resolution: object | null;
}

/**
 * INSERT … ON CONFLICT DO NOTHING without a conflict target: every unique index of the table is an
 * arbiter (recon_diffs_business_key, recon_diffs_dedupe_key_key, recon_diffs_month_end_key), and a
 * conflicting row of a concurrent open transaction is waited for, never raised as 23505.
 * The inserted row, or undefined when a unique key already holds one.
 */
export async function insertReconDiffIfAbsent(
  trx: Transaction<DB>,
  row: ReconDiffInsert,
): Promise<ReconDiffRow | undefined> {
  return trx
    .withSchema('app')
    .insertInto('recon_diffs')
    .values({ ...row, resolution: row.resolution as Insertable<DB['recon_diffs']>['resolution'] })
    .onConflict((conflict) => conflict.doNothing())
    .returningAll()
    .executeTakeFirst();
}

export async function findReconDiffByDedupeKey(
  trx: Transaction<DB>,
  appId: string,
  dedupeKey: string,
): Promise<ReconDiffRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('dedupe_key', '=', dedupeKey)
    .executeTakeFirst();
}

export async function findReconDiffByBusinessKey(
  trx: Transaction<DB>,
  key: {
    readonly appId: string;
    readonly type: string;
    readonly period: string;
    readonly refId: string;
  },
): Promise<ReconDiffRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', key.appId)
    .where('type', '=', key.type)
    .where('period', '=', key.period)
    .where('ref_id', '=', key.refId)
    .executeTakeFirst();
}

export async function findReconDiffByMonthEnd(
  trx: Transaction<DB>,
  appId: string,
  period: string,
): Promise<ReconDiffRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('type', '=', 'month_end_unbalanced')
    .where('period', '=', period)
    .executeTakeFirst();
}

/** One plain SELECT on the given handle (its snapshot, no lock), oldest first. */
export async function selectReconDiffs(
  db: Kysely<DB>,
  filter: {
    readonly appId: string;
    readonly status: string | undefined;
    readonly orderKey: string | undefined;
  },
): Promise<ReconDiffRow[]> {
  let query = db
    .withSchema('app')
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', filter.appId);
  if (filter.status !== undefined) query = query.where('status', '=', filter.status);
  if (filter.orderKey !== undefined) {
    query = query.where('ref_type', '=', 'order').where('ref_id', '=', filter.orderKey);
  }
  return query.orderBy('created_at').orderBy('id').execute();
}

/** B2-09a: the console filter of the R1–R3 recon diffs (every field ANDed; absent = all). */
export interface AdminReconDiffFilter {
  readonly appId: string;
  readonly type: string | undefined;
  readonly source: string | undefined;
  readonly status: string | undefined;
  readonly periodFrom: string | undefined;
  readonly periodTo: string | undefined;
  readonly refId: string | undefined;
}

/** The console's sources: R4 (收款对账) is payment's listAdminPayReconDiffs. */
const ADMIN_SOURCES = ['R1', 'R2', 'R3'];
const PERIOD_C = sql<string>`period collate "C"`;

function adminReconDiffQuery(db: Kysely<DB>, filter: AdminReconDiffFilter) {
  let query = db
    .withSchema('app')
    .selectFrom('recon_diffs')
    .where('app_id', '=', filter.appId)
    .where('source', 'in', ADMIN_SOURCES);
  if (filter.type !== undefined) query = query.where('type', '=', filter.type);
  if (filter.source !== undefined) query = query.where('source', '=', filter.source);
  if (filter.status !== undefined) query = query.where('status', '=', filter.status);
  // Plain string order (a YYYY-MM period before the days of its month), whatever the collation.
  if (filter.periodFrom !== undefined) query = query.where(PERIOD_C, '>=', filter.periodFrom);
  if (filter.periodTo !== undefined) query = query.where(PERIOD_C, '<=', filter.periodTo);
  if (filter.refId !== undefined) query = query.where('ref_id', '=', filter.refId);
  return query;
}

export async function countAdminReconDiffs(
  db: Kysely<DB>,
  filter: AdminReconDiffFilter,
): Promise<number> {
  const row = await adminReconDiffQuery(db, filter)
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  return Number(row.total);
}

/** One page of the filter set, created_at then id descending. */
export async function pageAdminReconDiffs(
  db: Kysely<DB>,
  filter: AdminReconDiffFilter,
  offset: number,
  limit: number,
): Promise<ReconDiffRow[]> {
  return adminReconDiffQuery(db, filter)
    .selectAll()
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .offset(offset)
    .limit(limit)
    .execute();
}

/** The app's R1–R3 recon diff of this id (undefined for any other). */
export async function findAdminReconDiff(
  db: Kysely<DB>,
  appId: string,
  id: string,
): Promise<ReconDiffRow | undefined> {
  return db
    .withSchema('app')
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('source', 'in', ADMIN_SOURCES)
    .where('id', '=', id)
    .executeTakeFirst();
}
