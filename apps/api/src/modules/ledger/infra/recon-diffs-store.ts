// SQL of app.recon_diffs for the ledger (its single writer, 04 §3.2). Every statement runs on the
// handle or transaction it is given; reads never lock.
import type { DB } from '@couli/db';
import type { Insertable, Kysely, Selectable, Transaction } from 'kysely';

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
