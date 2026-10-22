// Asset daily snapshot (BR-FUND-18, BR-FUND-20; settlement-plan §2.3, S3 A, S15 A). The run of
// nominal time D+1 00:01 +08:00 writes D once per app: balances from entries dated ≤ D, union
// receivables per platform, and waiting / estimated from the PendingEarningsSource port at run
// time. A snapshot row is its own completion mark; lateness is judged against D+1 00:30 +08:00.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { addFen } from '@couli/money';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import {
  findSnapshot,
  insertReceivables,
  insertSnapshotIfAbsent,
  sumReceivables,
  sumUserBalances,
  type PlatformReceivable,
} from '../infra/asset-snapshot-store.ts';
import { isPastDeadline, snapshotDayOf, snapshotDeadlineMs } from './asset-snapshot-days.ts';
import { LedgerError } from './errors.ts';

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

interface WriteOutcome {
  readonly snapshotId: string;
  /** False when another delivery committed the day first (nothing was written by this call). */
  readonly inserted: boolean;
  readonly waitingComparable: boolean;
  readonly receivables: readonly PlatformReceivable[];
}

// TODO(规划/11 §4.2): worker 在会计日 D+1 00:01 +08:00 按 app 调度本运行器 — blocked on B2-04zb（调度接线，本任务路径之外）
export function createAssetSnapshot(dependencies: AssetSnapshotDependencies): AssetSnapshotRunner {
  const { clock, pendingEarnings, logger } = dependencies;
  return {
    async run(db, input) {
      const appId = validAppId(input.appId);
      const day = snapshotDayOf(input.nominalRunAt);
      const result = { accountingDate: day };

      let outcome: WriteOutcome;
      let threshold: bigint | null;
      try {
        // Replay of a completed day: same snapshot, no source read, no alert (idempotent on
        // (app_id, snapshot_date)).
        const existing = await findSnapshot(db, appId, day);
        if (existing !== undefined) return { ...result, snapshotId: existing.id };
        // Read before writing: a failing config read must not leave a committed day whose
        // exposure alert can never be sent again.
        threshold = await dependencies.getAdvanceAlertFen(appId);
        outcome = await db
          .transaction()
          .setIsolationLevel('read committed')
          .execute(async (trx) => {
            const balances = await sumUserBalances(trx, appId, day);
            const receivables = await sumReceivables(trx, appId, day);
            // Run-time order state (BR-FUND-18): no D cutoff on waiting / estimated.
            const pending = await pendingEarnings.readAppTotals(trx, { appId });
            const at = clock.now();
            const waitingComparable = !isPastDeadline(at, day);
            const id = randomUUID();
            const inserted = await insertSnapshotIfAbsent(trx, {
              id,
              app_id: appId,
              snapshot_date: day,
              ...balances,
              total_waiting_fen: pending.total_waiting_fen,
              total_estimated_fen: pending.total_estimated_fen,
              waiting_comparable: waitingComparable,
              at,
            });
            if (!inserted) {
              // A concurrent delivery committed first; its row is the day's snapshot.
              const winner = await findSnapshot(trx, appId, day);
              if (winner === undefined) {
                throw new Error(`asset snapshot ${appId} ${day} conflicted but is not visible`);
              }
              return {
                snapshotId: winner.id,
                inserted: false,
                waitingComparable: winner.waiting_comparable,
                receivables,
              };
            }
            await insertReceivables(trx, appId, id, receivables);
            return { snapshotId: id, inserted: true, waitingComparable, receivables };
          });
      } catch (error) {
        // Still not complete at or after the deadline: waiters learn it from the status read,
        // finance from this alert. No placeholder row is written.
        if (isPastDeadline(clock.now(), day)) {
          logger.error(
            { event: 'asset_snapshot_timeout', app_id: appId, accounting_date: day, step: 'run' },
            'asset snapshot not completed by its deadline',
          );
        }
        throw error;
      }

      // Alerts only after commit and only by the delivery that wrote the day: one per app per D.
      if (outcome.inserted) {
        if (!outcome.waitingComparable) {
          logger.warn(
            {
              event: 'asset_snapshot_timeout',
              app_id: appId,
              accounting_date: day,
              step: 'completed_late',
              waiting_comparable: false,
            },
            'asset snapshot completed after its deadline',
          );
        }
        alertExposure(logger, appId, day, outcome.receivables, threshold);
      }
      return { ...result, snapshotId: outcome.snapshotId };
    },
  };
}

/** S15: read-only, no settle_jobs, no source calls, no placeholder snapshot on timeout. */
export async function getAssetSnapshotStatus(
  db: Kysely<DB>,
  input: AssetSnapshotSelection,
  clock: Clock,
): Promise<AssetSnapshotStatus> {
  const appId = validAppId(input.appId);
  // Validates D and fixes the deadline to D+1 00:30 +08:00, whatever day the read happens on.
  const deadlineMs = snapshotDeadlineMs(input.accountingDate);
  const row = await findSnapshot(db, appId, input.accountingDate);
  if (row !== undefined) {
    return { state: 'complete', snapshotId: row.id, waitingComparable: row.waiting_comparable };
  }
  const state = clock.now().getTime() >= deadlineMs ? 'timed_out' : 'pending';
  return { state, snapshotId: null, waitingComparable: null };
}

/** BR-FUND-20: total over platforms (negative nets included) strictly above the threshold. */
function alertExposure(
  logger: AssetSnapshotLogger,
  appId: string,
  day: string,
  receivables: readonly PlatformReceivable[],
  threshold: bigint | null,
): void {
  if (threshold === null) return;
  let total = 0n;
  for (const row of receivables) total = addFen(total, row.union_receivable_fen);
  if (total <= threshold) return;
  logger.warn(
    {
      event: 'ledger_advance_exposure',
      app_id: appId,
      accounting_date: day,
      union_receivable_fen: total.toString(),
      advance_alert_fen: threshold.toString(),
    },
    'union receivable exposure above ledger.advance_alert_fen',
  );
}

function validAppId(appId: unknown): string {
  if (typeof appId !== 'string' || appId === '') {
    throw new LedgerError('INVALID_INPUT', 'appId must be a non-empty string');
  }
  return appId;
}
