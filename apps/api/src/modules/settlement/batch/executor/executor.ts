// B2-04p: the settle batch executor (job batch_execute). BR-FUND-04 ⑦ ⑩ ⑫ and 细则「结算批次迁移表」
// SB5–SB9, 「到执行时刻开关为 off 与执行中跨日」; BR-FUND-18 (no batch between 00:00 and the day's
// asset snapshot); BR-FUND-20 (settle.auto.enabled stops a running batch); 规划/12 §4.3.
//
// run({ appId, batchId }) is one delivery of the batch_execute job. It never writes settle_jobs
// (batch progress lives in settle_batches / settle_batch_items, 规划/04 §3.2). Steps:
//   1. Read the batch for appId (another app's batch, or none: outcome 'idle', nothing written).
//      DRAFT, PARTIAL (no automatic resume), DONE, CANCELLED: 'idle', nothing written.
//   2. Executor liveness: at most one live executor per batch. The run holds a session-level
//      PostgreSQL advisory lock on the batch for its whole duration, on a connection of deps.db, and
//      releases it when the run ends; a crashed process loses it with its connection. A run that
//      cannot take it at once (another executor is alive) returns 'busy' without waiting and
//      without writing anything.
//   3. CONFIRMED (SB5), in this order:
//        a. paused_by_switch_at set: 'idle', nothing written (only SB10 may start it);
//        b. not yet at the execution instant (SCHEDULED and clock < scheduled_at): 'not_due';
//        c. settle.auto.enabled or credit.enabled.<platform> not on: write paused_by_switch_at =
//           clock.now() (row_version CAS, status stays CONFIRMED), 'switched_off' — before the
//           snapshot check, so also while the snapshot is pending;
//        d. today's asset snapshot (deps.snapshotStatus for D = the day before the +08:00
//           accounting date of clock.now()) neither complete nor timed out: 'snapshot_pending',
//           nothing written;
//        e. CONFIRMED → EXECUTING through the generated settle-batch transition() (event START), CAS
//           on (status, row_version); started_at = clock.now(). A lost CAS: 'busy'.
//      EXECUTING (SB9, no live executor since step 2 succeeded): the snapshot check d (else
//      'snapshot_pending', nothing written), then EXECUTING → EXECUTING (event TAKE_OVER, CAS; does
//      not touch started_at). A lost CAS: 'busy'.
//   4. Item loop: the items whose result is null, in ascending order_key of their order
//      (order_keys: `${platform}:${sub_order_id}`); an item with a result is never executed again.
//      Before each item:
//        - read settle.auto.enabled and credit.enabled.<platform> through deps.config (a value is
//          on only when it is true or 'on'; a missing credit.enabled is off; a cached value is at
//          most 10 seconds old by deps.clock): either off → stop, EXECUTING → PARTIAL (SB7, event
//          SWITCH_OFF, CAS), 'partial';
//        - the accounting date of clock.now() differs from the one the run started on and that
//          day's snapshot check d fails → stop, the batch stays EXECUTING, 'day_rollover'.
//      Each item runs in its own transaction of deps.db:
//        - item_type order: deps.creditOrder.credit(trx, { appId, orderId, expectedSettleSeq:
//          item.settle_seq, openedRef: item.id }); credited → result 'credited'; skipped → result
//          'skipped' and skip_reason = the returned reason (e.g. 'not_waiting',
//          'tlj_deduct_unsupported'); amount_fen stays null;
//        - item_type beneficiary: deps.creditBeneficiary.execute(trx, …) (B2-04q); result /
//          amount_fen / skip_reason as returned;
//        - the item row is written on the same transaction as the credit. Right before commit the
//          day check above runs again: crossed into a day whose snapshot check d fails → the
//          transaction rolls back (the item stays unprocessed) and the run ends 'day_rollover'.
//      An unexpected error of an item transaction rolls it back and run() rejects with that error;
//      the batch stays EXECUTING for a later SB9 take-over.
//   5. No item left: one transaction moves EXECUTING → DONE (SB6, event COMPLETE, CAS), sets
//      finished_at = clock.now() and publishes settle.batch_done (payload with batch_id) through
//      deps.events on that same transaction; 'done'. A failing publish rolls the transaction back
//      (the batch stays EXECUTING) and run() rejects.
// Batch status only through the generated settle-batch transition(), every write a row_version CAS.
// Time only from deps.clock; logs only through deps.logger.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, EventBus, RootLogger } from '../../../platform/index.ts';
import type { CreditOrder, CreditRole } from '../../credit/index.ts';

export interface BatchExecuteInput {
  readonly appId: string;
  readonly batchId: string;
}

/**
 * done: SB6 reached by this run. partial: SB7 (a switch was off before an item). day_rollover:
 * stopped after crossing into a day whose snapshot is not ready (the batch stays EXECUTING).
 * not_due / snapshot_pending: nothing written. switched_off: CONFIRMED at its execution instant
 * with a switch off, paused_by_switch_at written. idle: nothing to execute, nothing written.
 * busy: another executor is alive or won the CAS, nothing written.
 */
export type BatchExecuteOutcome =
  | 'done'
  | 'partial'
  | 'day_rollover'
  | 'not_due'
  | 'snapshot_pending'
  | 'switched_off'
  | 'idle'
  | 'busy';

export interface BatchExecuteResult {
  readonly outcome: BatchExecuteOutcome;
}

/** A beneficiary item of BR-FUND-04 ⑫, handed to the B2-04q executor on the item transaction. */
export interface BeneficiaryItemInput {
  readonly appId: string;
  readonly batchId: string;
  /** settle_batch_items.id */
  readonly itemId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly role: CreditRole;
  readonly beneficiaryCreditId: string;
  /** settle_batch_items.settle_seq: the order_settlements seq when the item was generated. */
  readonly expectedSettleSeq: number;
}

/** What the item row records: credited with amount_fen, deferred, or skipped with skip_reason. */
export type BeneficiaryItemResult =
  | { readonly result: 'credited'; readonly amountFen: bigint }
  | { readonly result: 'deferred' }
  | { readonly result: 'skipped'; readonly reason: string };

/** Port of the beneficiary supplement credit (B2-04q, R5a); runs on the caller's transaction. */
export interface BeneficiaryItemCredit {
  execute(trx: Transaction<DB>, input: BeneficiaryItemInput): Promise<BeneficiaryItemResult>;
}

export interface BatchExecutorDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  /** content config reader: settle.auto.enabled, credit.enabled.<platform>. */
  readonly config: { get(appId: string, key: string): Promise<unknown> };
  /** ledger getAssetSnapshotStatus (B2-04w); D is the snapshot's own accounting date. */
  snapshotStatus(
    db: Kysely<DB>,
    input: { readonly appId: string; readonly accountingDate: string },
    clock: Clock,
  ): Promise<{
    readonly state: 'pending' | 'complete' | 'timed_out';
    readonly snapshotId: string | null;
    readonly waitingComparable: boolean | null;
  }>;
  /** B2-04m single-order credit. */
  readonly creditOrder: Pick<CreditOrder, 'credit'>;
  // TODO(规划/11 §4.2): 接入 B2-04q 的受益人补记执行 — blocked on B2-04q 未合并（先声明端口）
  /** B2-04q beneficiary supplement credit. */
  readonly creditBeneficiary: BeneficiaryItemCredit;
  readonly events: Pick<EventBus, 'publish'>;
}

export interface BatchExecutor {
  run(input: BatchExecuteInput): Promise<BatchExecuteResult>;
}

export function createBatchExecutor(deps: BatchExecutorDependencies): BatchExecutor {
  void deps;
  throw new Error('NotImplemented: createBatchExecutor');
}
