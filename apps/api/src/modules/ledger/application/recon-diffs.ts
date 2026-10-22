import type { ReconDiffStatus, ReconDiffType } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { Clock, JobPayload } from '../../platform/index.ts';

export type ReconDiff = Selectable<DB['recon_diffs']>;

/** Registration only: no handler, closing, or status transition is accepted. */
export interface RegisterReconDiffInput {
  readonly appId: string;
  readonly type: ReconDiffType;
  readonly source: 'R1' | 'R2' | 'R3' | 'R4';
  readonly period: string;
  readonly refType: string;
  readonly refId: string;
  /** Signed integer fen supplied by the detecting caller; no implicit sign conversion. */
  readonly expectedFen: bigint;
  readonly actualFen: bigint;
  readonly diffFen: bigint;
  readonly dedupeKey: string | null;
  readonly resolution: JobPayload | null;
}

export interface ReconDiffSelection {
  readonly appId: string;
  readonly status?: ReconDiffStatus;
  /** Stored as ref_type='order', ref_id=orderKey; recon_diffs has no order_key column. */
  readonly orderKey?: string;
}

/** Insert open, or return the existing row under any recon_diffs unique business key. */
export async function registerReconDiff(
  trx: Transaction<DB>,
  input: RegisterReconDiffInput,
  dependencies: { readonly clock: Clock },
): Promise<ReconDiff> {
  void trx;
  void input;
  void dependencies;
  throw new Error('NotImplemented: registerReconDiff');
}

/** Uses the supplied connection/snapshot and never locks or writes. */
export async function getReconDiffs(
  db: Kysely<DB>,
  selection: ReconDiffSelection,
): Promise<readonly ReconDiff[]> {
  void db;
  void selection;
  throw new Error('NotImplemented: getReconDiffs');
}
