// Write phase of the asset daily snapshot (BR-FUND-18, BR-FUND-20). The amounts come from one
// read-only REPEATABLE READ snapshot taken before; this phase runs in one READ COMMITTED
// transaction (the platform event bus refuses any other level) and writes, all or nothing: the
// day's row, its per-platform receivables, the durable alerts of the day, and — when the clock
// read after every write is at or past D+1 00:30 — waiting_comparable = false. COMMIT itself is
// covered by recheckCommittedDay, run by the caller after the commit has returned.
import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import { addFen } from '@couli/money';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type {
  LedgerBalanceTotals,
  PlatformReceivable,
  SnapshotInsert,
  SnapshotRow,
} from '../infra/asset-snapshot-store.ts';
import { isPastDeadline } from './asset-snapshot-days.ts';

export type AssetSnapshotAlertKind = 'asset_snapshot_timeout' | 'ledger_advance_exposure';

/**
 * A finance alert of the day. (app_id, accounting date, kind) is its idempotency key: `key` as
 * text, `eventId` as a deterministic lower-case canonical UUID of the same key (usable as the
 * event id of the platform event bus, whose consumers dedup on it). Payload values are strings
 * or flags; amounts are decimal strings, preserving bigint precision.
 */
export interface AssetSnapshotAlert {
  readonly kind: AssetSnapshotAlertKind;
  readonly appId: string;
  readonly accountingDate: string;
  readonly key: string;
  readonly eventId: string;
  readonly payload: Readonly<Record<string, string | boolean>>;
}

/**
 * Durable alert queue (BR-FUND-20 "告警财务 1 次", BR-FUND-18 超时告警): `enqueue` runs on the
 * snapshot's write transaction, so an alert exists exactly when the day's row is committed.
 * Optional like EVENT_BUS; implementations must dedup on `eventId` / `key`.
 */
// TODO(规划/11 §4.2): AssetSnapshotAlertQueue 的持久化实现与必需注入 — blocked on B2-04wa
export interface AssetSnapshotAlertQueue {
  enqueue(
    trx: Transaction<DB>,
    alert: AssetSnapshotAlert,
  ): Promise<{ readonly duplicate: boolean }>;
}

/** The statements the write phase needs; the infra store in production, fakes in unit tests. */
export interface SnapshotWriteStore {
  insertSnapshotIfAbsent(trx: Transaction<DB>, row: SnapshotInsert): Promise<boolean>;
  insertReceivables(
    trx: Transaction<DB>,
    appId: string,
    snapshotId: string,
    rows: readonly PlatformReceivable[],
  ): Promise<void>;
  /** true → false only; resolves true when this call changed the row. */
  markNotComparable(
    trx: Transaction<DB>,
    appId: string,
    snapshotId: string,
    at: Date,
  ): Promise<boolean>;
  findSnapshot(
    trx: Transaction<DB>,
    appId: string,
    accountingDate: string,
  ): Promise<SnapshotRow | undefined>;
}

/** Everything read from the one consistent snapshot, and the clock read right after it. */
export interface SnapshotReads {
  readonly balances: LedgerBalanceTotals;
  readonly receivables: readonly PlatformReceivable[];
  readonly totalWaitingFen: bigint;
  readonly totalEstimatedFen: bigint;
  readonly readAt: Date;
}

export interface SnapshotWriteContext {
  readonly store: SnapshotWriteStore;
  readonly clock: Clock;
  readonly alertQueue?: AssetSnapshotAlertQueue;
  readonly newId: () => string;
}

export interface SnapshotWriteInput {
  readonly appId: string;
  readonly day: string;
  readonly reads: SnapshotReads;
  /** ledger.advance_alert_fen of the app; null means not configured (no exposure alert). */
  readonly threshold: bigint | null;
}

export interface SnapshotWriteOutcome {
  readonly snapshotId: string;
  /** False when another delivery committed the day first (nothing was written by this call). */
  readonly inserted: boolean;
  readonly waitingComparable: boolean;
  /** The alerts written with the day (empty when not inserted), to log after commit. */
  readonly alerts: readonly AssetSnapshotAlert[];
}

export async function writeSnapshotDay(
  trx: Transaction<DB>,
  context: SnapshotWriteContext,
  input: SnapshotWriteInput,
): Promise<SnapshotWriteOutcome> {
  const { store, clock, alertQueue } = context;
  const { appId, day, reads, threshold } = input;
  const id = context.newId();
  let waitingComparable = !isPastDeadline(reads.readAt, day);
  const inserted = await store.insertSnapshotIfAbsent(trx, {
    id,
    app_id: appId,
    snapshot_date: day,
    ...reads.balances,
    total_waiting_fen: reads.totalWaitingFen,
    total_estimated_fen: reads.totalEstimatedFen,
    waiting_comparable: waitingComparable,
    at: reads.readAt,
  });
  if (!inserted) {
    // A concurrent delivery committed first; its row (and its alerts) are the day's.
    const winner = await store.findSnapshot(trx, appId, day);
    if (winner === undefined) {
      throw new Error(`asset snapshot ${appId} ${day} conflicted but is not visible`);
    }
    return {
      snapshotId: winner.id,
      inserted: false,
      waitingComparable: winner.waiting_comparable,
      alerts: [],
    };
  }
  await store.insertReceivables(trx, appId, id, reads.receivables);

  const alerts: AssetSnapshotAlert[] = [];
  const exposure = exposureAlert(appId, day, reads.receivables, threshold);
  if (exposure !== undefined) {
    if (alertQueue !== undefined) await alertQueue.enqueue(trx, exposure);
    alerts.push(exposure);
  }
  // BR-FUND-18: lateness covers every write of this transaction; COMMIT is rechecked afterwards.
  const writtenAt = clock.now();
  if (waitingComparable && isPastDeadline(writtenAt, day)) {
    await store.markNotComparable(trx, appId, id, writtenAt);
    waitingComparable = false;
  }
  if (!waitingComparable) {
    const timeout = timeoutAlert(appId, day, 'completed_late');
    if (alertQueue !== undefined) await alertQueue.enqueue(trx, timeout);
    alerts.push(timeout);
  }
  return { snapshotId: id, inserted: true, waitingComparable, alerts };
}

/** Runs `work` in a new READ COMMITTED transaction (the runner's); a pass-through in unit tests. */
export type Transact = <T>(work: (trx: Transaction<DB>) => Promise<T>) => Promise<T>;

export interface CommittedDay {
  readonly appId: string;
  readonly day: string;
  readonly snapshotId: string;
  /** The row's waiting_comparable as committed (or as read back after an uncertain commit). */
  readonly waitingComparable: boolean;
}

/**
 * BR-FUND-18 on the commit boundary: called once COMMIT has returned (or, after an uncertain
 * commit, once the row is read back). The row only became visible to waiters at commit, so a
 * clock read at or past D+1 00:30 now means the day completed late: in a new transaction the row
 * goes true → false (never back) and the timeout alert is enqueued under the same key as before.
 * When another transaction already changed the row, nothing is written or enqueued again.
 * Returns the alerts written, to log after this second commit.
 */
export async function recheckCommittedDay(
  transact: Transact,
  context: Pick<SnapshotWriteContext, 'store' | 'clock' | 'alertQueue'>,
  committed: CommittedDay,
): Promise<readonly AssetSnapshotAlert[]> {
  if (!committed.waitingComparable) return [];
  const at = context.clock.now();
  if (!isPastDeadline(at, committed.day)) return [];
  const { appId, day, snapshotId } = committed;
  return transact(async (trx) => {
    const changed = await context.store.markNotComparable(trx, appId, snapshotId, at);
    if (!changed) return [];
    const timeout = timeoutAlert(appId, day, 'committed_late');
    if (context.alertQueue !== undefined) await context.alertQueue.enqueue(trx, timeout);
    return [timeout];
  });
}

function timeoutAlert(
  appId: string,
  day: string,
  step: 'completed_late' | 'committed_late',
): AssetSnapshotAlert {
  return alert('asset_snapshot_timeout', appId, day, { step, waiting_comparable: false });
}

/** BR-FUND-20: total over platforms (negative nets included) strictly above the threshold. */
function exposureAlert(
  appId: string,
  day: string,
  receivables: readonly PlatformReceivable[],
  threshold: bigint | null,
): AssetSnapshotAlert | undefined {
  if (threshold === null) return undefined;
  let total = 0n;
  for (const row of receivables) total = addFen(total, row.union_receivable_fen);
  if (total <= threshold) return undefined;
  return alert('ledger_advance_exposure', appId, day, {
    union_receivable_fen: total.toString(),
    advance_alert_fen: threshold.toString(),
  });
}

function alert(
  kind: AssetSnapshotAlertKind,
  appId: string,
  day: string,
  payload: Readonly<Record<string, string | boolean>>,
): AssetSnapshotAlert {
  const key = JSON.stringify([appId, day, kind]);
  return {
    kind,
    appId,
    accountingDate: day,
    key,
    eventId: alertEventId(key),
    payload: { app_id: appId, accounting_date: day, ...payload },
  };
}

/** A name-based UUID (RFC 9562 version 8 layout, SHA-256 of the key): same key, same id. */
export function alertEventId(key: string): string {
  const hex = createHash('sha256').update(`asset-snapshot-alert\u0000${key}`).digest('hex');
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
