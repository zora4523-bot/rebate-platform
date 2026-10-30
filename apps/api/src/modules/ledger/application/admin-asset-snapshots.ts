// B2-09e: the console read of the daily asset snapshots (contracts/openapi.yaml
// listAdminAssetSnapshots, CT-24zb; 08 BR-FUND-18; 04 §3.2 asset_snapshots,
// asset_snapshot_receivables). Read only on the given handle, by app; the permission check
// (fund.view, read only) is the controller's and appId is always the guard's actor. Amounts are the
// stored integer fen, never recomputed; a day without a written snapshot has no row and reading
// never writes, triggers or audits anything. date_from > date_to is refused with
// data.fields=[date_from, date_to]; snapshot_date descending.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { fenToJsonNumber } from '@couli/money';
import { sql, type Kysely } from 'kysely';

/** A 20001 with data.fields (the snapshot day range). */
export class AssetSnapshotFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super('ledger: admin asset snapshot read refused');
    this.name = 'AssetSnapshotFieldsError';
    this.fields = fields;
  }
}

/** Contract AdminPage / AdminPageSize defaults. */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

/** The query of listAdminAssetSnapshots after the route schema (page / page_size as integers). */
export interface AssetSnapshotListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly date_from?: string;
  readonly date_to?: string;
}

/** The app's snapshots in the day range (both ends inclusive, either may be absent). */
function snapshotQuery(db: Kysely<DB>, appId: string, query: AssetSnapshotListQuery) {
  let q = db.withSchema('app').selectFrom('asset_snapshots').where('app_id', '=', appId);
  if (query.date_from !== undefined) {
    q = q.where('snapshot_date', '>=', sql<Date>`${query.date_from}::date`);
  }
  if (query.date_to !== undefined) {
    q = q.where('snapshot_date', '<=', sql<Date>`${query.date_to}::date`);
  }
  return q;
}

/** One page of the app's asset snapshots, snapshot_date descending, receivables by platform. */
export async function listAdminAssetSnapshots(
  db: Kysely<DB>,
  appId: string,
  query: AssetSnapshotListQuery,
): Promise<Schema<'AdminAssetSnapshotPage'>> {
  // The route schema has checked both are YYYY-MM-DD dates, so string order is day order.
  if (
    query.date_from !== undefined &&
    query.date_to !== undefined &&
    query.date_from > query.date_to
  ) {
    throw new AssetSnapshotFieldsError(['date_from', 'date_to']);
  }
  const page = query.page ?? DEFAULT_PAGE;
  const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
  const counted = await snapshotQuery(db, appId, query)
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  const total = Number(counted.total);
  const offset = (page - 1) * pageSize;
  if (offset >= total) return { items: [], page, page_size: pageSize, total };

  const rows = await snapshotQuery(db, appId, query)
    .select([
      'id',
      // The date column as its YYYY-MM-DD text: no time zone conversion of a JS Date.
      sql<string>`to_char(snapshot_date, 'YYYY-MM-DD')`.as('day'),
      'total_available_positive_fen',
      'total_negative_fen',
      'total_frozen_fen',
      'total_waiting_fen',
      'total_estimated_fen',
      'waiting_comparable',
      'created_at',
      'updated_at',
    ])
    .orderBy('snapshot_date', 'desc')
    .offset(offset)
    .limit(pageSize)
    .execute();
  const receivables = new Map<string, Schema<'AdminAssetSnapshotReceivable'>[]>();
  if (rows.length > 0) {
    const found = await db
      .withSchema('app')
      .selectFrom('asset_snapshot_receivables')
      .select(['asset_snapshot_id', 'platform', 'union_receivable_fen'])
      .where('app_id', '=', appId)
      .where(
        'asset_snapshot_id',
        'in',
        rows.map((row) => row.id),
      )
      .execute();
    // Platform code in plain code-unit order (independent of the database collation).
    found.sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0));
    for (const row of found) {
      const list = receivables.get(row.asset_snapshot_id) ?? [];
      list.push({
        platform: row.platform as Schema<'AdminAssetSnapshotReceivable'>['platform'],
        union_receivable_fen: fenToJsonNumber(row.union_receivable_fen),
      });
      receivables.set(row.asset_snapshot_id, list);
    }
  }
  const items = rows.map((row): Schema<'AdminAssetSnapshot'> => ({
    snapshot_date: row.day,
    total_available_positive_fen: fenToJsonNumber(row.total_available_positive_fen),
    total_negative_fen: fenToJsonNumber(row.total_negative_fen),
    total_frozen_fen: fenToJsonNumber(row.total_frozen_fen),
    total_waiting_fen: fenToJsonNumber(row.total_waiting_fen),
    total_estimated_fen: fenToJsonNumber(row.total_estimated_fen),
    waiting_comparable: row.waiting_comparable,
    receivables: receivables.get(row.id) ?? [],
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
  return { items, page, page_size: pageSize, total };
}
