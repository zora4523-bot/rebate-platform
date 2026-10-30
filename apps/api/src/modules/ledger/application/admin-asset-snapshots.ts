// B2-09e: the console read of the daily asset snapshots (contracts/openapi.yaml
// listAdminAssetSnapshots, CT-24zb; 08 BR-FUND-18; 04 §3.2 asset_snapshots,
// asset_snapshot_receivables). Read only on the given handle, by app; the permission check
// (fund.view, read only) is the controller's and appId is always the guard's actor. Amounts are the
// stored integer fen, never recomputed; a day without a written snapshot has no row and reading
// never writes, triggers or audits anything. date_from > date_to is refused with
// data.fields=[date_from, date_to]; snapshot_date descending.
// Skeleton (rule-test round): the implementation replaces the body.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** The query of listAdminAssetSnapshots after the route schema (page / page_size as integers). */
export interface AssetSnapshotListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly date_from?: string;
  readonly date_to?: string;
}

/** One page of the app's asset snapshots, snapshot_date descending, receivables by platform. */
export function listAdminAssetSnapshots(
  db: Kysely<DB>,
  appId: string,
  query: AssetSnapshotListQuery,
): Promise<Schema<'AdminAssetSnapshotPage'>> {
  void db;
  void appId;
  void query;
  throw new Error('NotImplemented: listAdminAssetSnapshots');
}
