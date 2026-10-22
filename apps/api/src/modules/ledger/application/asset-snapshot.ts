import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface PendingEarningsTotals {
  readonly total_waiting_fen: bigint;
  readonly total_estimated_fen: bigint;
}

export interface PendingUserEarnings {
  readonly estimated_fen: bigint;
  readonly pending_credit_fen: bigint;
  readonly pending_credit_paused_fen: bigint;
  readonly next_credit_period: string | null;
  readonly credit_overdue: boolean;
}

/** S3: declared by ledger, implemented by settlement and injected at assembly time.
 * Reads current order state, including beneficiaries without a ledger account.
 * The supplied database may be the caller's transaction; no historical date filter.
 */
export interface PendingEarningsSource {
  readAppTotals(db: Kysely<DB>, input: { readonly appId: string }): Promise<PendingEarningsTotals>;
  readUser(
    db: Kysely<DB>,
    input: { readonly appId: string; readonly userId: string },
  ): Promise<PendingUserEarnings>;
}

/** Flat fields are compatible with an injected pino logger / finance alert routing.
 * Events: asset_snapshot_timeout and ledger_advance_exposure; app_id/accounting_date
 * identify the day. Exposure alerts carry union_receivable_fen/advance_alert_fen as
 * decimal strings, preserving bigint precision when serialized.
 */
export interface AssetSnapshotLogger {
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}

export interface AssetSnapshotDependencies {
  readonly clock: Clock;
  readonly pendingEarnings: PendingEarningsSource;
  readonly logger: AssetSnapshotLogger;
  /** Reads ledger.advance_alert_fen for this app; null means not configured. */
  getAdvanceAlertFen(appId: string): Promise<bigint | null>;
}

export interface AssetSnapshotInput {
  readonly appId: string;
  /** D+1 00:01 +08:00, retained on delayed delivery; actual time comes from Clock. */
  readonly nominalRunAt: Date;
}

export interface AssetSnapshotResult {
  readonly snapshotId: string;
  readonly accountingDate: string;
}

export interface AssetSnapshotRunner {
  run(db: Kysely<DB>, input: AssetSnapshotInput): Promise<AssetSnapshotResult>;
}

export interface AssetSnapshotSelection {
  readonly appId: string;
  /** D, the snapshot's own accounting date, not D+1 (the execution day). */
  readonly accountingDate: string;
}

export interface AssetSnapshotStatus {
  /** An existing row is complete, even if its waiting amount is not comparable. */
  readonly state: 'pending' | 'complete' | 'timed_out';
  readonly snapshotId: string | null;
  readonly waitingComparable: boolean | null;
}

export function createAssetSnapshot(dependencies: AssetSnapshotDependencies): AssetSnapshotRunner {
  void dependencies;
  throw new Error('NotImplemented: createAssetSnapshot');
}

/** S15: read-only, no settle_jobs, no source calls, no placeholder snapshot on timeout. */
export function getAssetSnapshotStatus(
  db: Kysely<DB>,
  input: AssetSnapshotSelection,
  clock: Clock,
): Promise<AssetSnapshotStatus> {
  void db;
  void input;
  void clock;
  throw new Error('NotImplemented: getAssetSnapshotStatus');
}
