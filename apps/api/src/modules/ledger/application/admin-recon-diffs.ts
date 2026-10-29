// B2-09a: the console reads of recon_diffs of sources R1–R3 (contracts/openapi.yaml
// listAdminReconDiffs, getAdminReconDiff; 08 BR-FUND-22 差错单). Read only on the given handle, by
// app; source R4 (收款对账) stays with payment's listAdminPayReconDiffs. Skeleton (NotImplemented).
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** The query of listAdminReconDiffs after the route schema (page / page_size as integers). */
export interface ReconDiffListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly type?: Schema<'AdminReconDiffType'>;
  readonly source?: Schema<'AdminReconDiffSource'>;
  readonly status?: Schema<'AdminReconDiffStatus'>;
  readonly period_from?: string;
  readonly period_to?: string;
  readonly ref_id?: string;
}

/** One page of the app's R1–R3 recon diffs, created_at then id descending. */
export function listAdminReconDiffs(
  db: Kysely<DB>,
  appId: string,
  query: ReconDiffListQuery,
): Promise<Schema<'AdminReconDiffPage'>> {
  void db;
  void appId;
  void query;
  throw new Error('NotImplemented: listAdminReconDiffs');
}

/** One R1–R3 recon diff of the app with its handling summary; otherwise recon_diff_id refused. */
export function getAdminReconDiff(
  db: Kysely<DB>,
  appId: string,
  reconDiffId: string,
): Promise<Schema<'AdminReconDiffDetail'>> {
  void db;
  void appId;
  void reconDiffId;
  throw new Error('NotImplemented: getAdminReconDiff');
}
