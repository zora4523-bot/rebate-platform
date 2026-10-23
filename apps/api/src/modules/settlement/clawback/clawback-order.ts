// B2-04s: post-credit clawback orchestration (BR-FUND-01 R8 / R9 / R9b; BR-FUND-08; BR-FUND-10;
// BR-CALC-09). Skeleton written with the rule tests (test/spec/settlement/clawback/**): every
// function only throws NotImplemented. The contract below is what those tests pin.
//
// apply(trx, command): one reverse event on one CREDITED sub-order, on the caller's transaction
// (never opens, commits or rolls back one). In order:
//   1. pg_advisory_xact_lock(order_key) through orders' lockOrderKey, then re-read the order; a
//      rebate_status other than CREDITED → { outcome: 'skipped', reason: 'not_credited' } and
//      nothing is written (a replay of an R8 event lands here).
//   2. rights_event_id (BR-FUND-08): ref rights → `R{orderRightsId}`; ref platform →
//      `P{orders.row_version}` as re-read under the lock (the row_version written by the sync
//      update that carried the platform status change); ref commission →
//      `C{orders.commission_version}` as re-read.
//   3. N_new (BR-FUND-08, @couli/domain selectClawbackCommission): the full causes
//      PLATFORM_INVALID, INVALID_AFTER_SETTLE, REFUND_AFTER_SETTLE and PUNISH → 0; otherwise
//      ① command.newCommissionFen, ② booked_n_fen − command.rightsDeductFen (below 0 → 0),
//      ③ neither → WAIT_COMMISSION (S12): no voucher, no rebate transition; the order_rights row
//      of a rights ref → status WAIT_COMMISSION and orders.rights_pending recomputed in the same
//      transaction; deps.pending.open(reason CLAWBACK_NO_COMMISSION); one warn log line carrying
//      an `alert` field and app_id; result { outcome: 'wait_commission' }.
//   4. cause COMMISSION is a reverse event only when the plan is R8 (N_new positive part 0, or
//      booked_base_fen > 0 and B_new 0); any other result → skipped 'not_reverse', nothing written
//      (left to R10 / BR-FUND-09).
//   5. users rows (gate.lockUsers, ascending) → ledger.lockBalances → gate.readStates after the
//      locks (B2-04m lock flow); beneficiary nets and the platform net from ledger getOrderNets;
//      the plan from @couli/domain planCommissionAdjustment({ event: 'clawback', … }) with the
//      snapshot reserve_bp and ratios (B_new = N_new per BR-CALC-02).
//   6. vouchers (voucher_kind CLAWBACK, ledger_type CLAWBACK, sub_type per the table below):
//      per beneficiary with delta < 0 `{order_key}:{user_id}:{role}:CLAWBACK:{rights_event_id}`
//      (USER_BALANCE.available debit / UNION_RECEIVABLE credit; available may go negative,
//      frozen is never touched; a beneficiary in deletion processing / done → BAD_DEBT debit
//      instead, same key, beneficiary columns kept); platform difference ≠ 0
//      `{order_key}:PLATFORM:CLAWBACK:{rights_event_id}` (DECREASE / INCREASE templates).
//      A stored uniq_key is a duplicate, never a second clawback.
//   7. unfinished obligations (beneficiary_credits): R8 → voided (closed_by R8); R9 → a
//      beneficiary whose remaining amount went to the platform → forfeited (closed_by R9) plus a
//      forfeited beneficiary event; others kept open.
//   8. pending settle_adjustments of this order → voided_by_clawback (decided_at = Clock now).
//   9. booked_base_fen = B_new and booked_n_fen = N_new positive part together, rebate_status
//      through the generated order-rebate transition() with a CAS on (rebate_status, row_version);
//      a rebate history row; R8 also writes orders.reason, R9 writes diff_reason_code PART_REFUND
//      and leaves orders.reason unchanged.
//  10. R8 publishes order.clawed_back on the same transaction.
//
// | cause                | R8 history event                       | R9 history event | sub_type        | R8 reason       |
// | PLATFORM_INVALID     | PLATFORM_INVALID                       | —                | FULL            | REFUND          |
// | INVALID_AFTER_SETTLE | INVALID_AFTER_SETTLE                   | —                | FULL            | REFUND          |
// | REFUND_AFTER_SETTLE  | REFUND_AFTER_SETTLE                    | —                | FULL            | REFUND          |
// | PUNISH               | PUNISH                                 | —                | PUNISH          | PUNISH          |
// | RIGHTS               | RIGHTS_FULL                            | RIGHTS_PARTIAL   | RIGHTS          | RIGHTS          |
// | PARTIAL_REFUND       | COMMISSION_POSITIVE_ZERO / BASE_ZERO   | PARTIAL_REFUND   | FULL / PART_REFUND | COMMISSION_ZERO |
// | COMMISSION           | COMMISSION_POSITIVE_ZERO / BASE_ZERO   | — (not_reverse)  | FULL            | COMMISSION_ZERO |
//
// onUpdated(trx, change, source): orders' sync hook (OrderUpdateDeps['rebate']['onUpdated'])
// for a CREDITED order, on the sync transaction, after orders wrote its columns:
//   - not CREDITED → skipped 'not_credited';
//   - source.event PLATFORM_INVALID (or to_status INVALID) → apply cause INVALID_AFTER_SETTLE
//     when change.from_status is SETTLED (P7), else PLATFORM_INVALID (P6); ref platform;
//   - source.event PLATFORM_PUNISH (P8) → apply cause PUNISH, ref platform;
//   - source.event PLATFORM_RIGHTS → skipped; TODO(规划/11 §4.2): rights success entry — blocked
//     on B2-04l;
//   - settlement record unchanged and est_commission_fen changed → R9b: archive only (no voucher,
//     booked pair unchanged); when the estimate's base (BR-CALC-02, snapshot reserve_bp) differs
//     from booked_base_fen and settle.estimate_change_diff.enabled is not off, register one
//     recon diff (ledger registerReconDiff, type estimate_changed_after_credit, ref_id naming the
//     order_key, expected_fen = booked_base_fen, actual_fen = that base, diff_fen = actual −
//     expected) once per sub-order and estimate value; result 'estimate_archived'.
// Amounts only through @couli/money; time only from the injected Clock.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Ledger } from '../../ledger/index.ts';
import type { OrderStatusSource, OrderUpdateChange } from '../../orders/index.ts';
import type { Clock, EventBus, RootLogger } from '../../platform/index.ts';
import type {
  BeneficiaryEventInput,
  BeneficiaryGate,
  CreditSnapshot,
  CreditSnapshotSelection,
} from '../credit/index.ts';

/** The reverse event behind one clawback (BR-FUND-08 细则「sub_type 与订单原因码」). */
export type ClawbackCause =
  | 'PLATFORM_INVALID'
  | 'INVALID_AFTER_SETTLE'
  | 'REFUND_AFTER_SETTLE'
  | 'PUNISH'
  | 'RIGHTS'
  | 'PARTIAL_REFUND'
  | 'COMMISSION';

/** Where the rights_event_id of the uniq_keys comes from (BR-FUND-08). */
export type ClawbackEventRef =
  | { readonly kind: 'rights'; readonly orderRightsId: string }
  | { readonly kind: 'platform' }
  | { readonly kind: 'commission' };

export interface ClawbackCommand {
  readonly appId: string;
  readonly orderId: string;
  readonly cause: ClawbackCause;
  readonly ref: ClawbackEventRef;
  /** ① the union's new effective commission brought by this event (raw, may be ≤ 0); or null. */
  readonly newCommissionFen: bigint | null;
  /** ② the commission to deduct given by the order_rights record; or null. */
  readonly rightsDeductFen: bigint | null;
}

/** One order_sync_pending entry (orders owns the table; 待编排裁定: writer port at assembly). */
export interface ClawbackPendingInput {
  readonly appId: string;
  readonly orderId: string;
  readonly platform: string;
  readonly subOrderId: string;
  readonly reason: 'CLAWBACK_NO_COMMISSION';
  readonly detail: string | null;
}

export interface ClawbackDependencies {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly ledger: Pick<Ledger, 'openUserAccount' | 'lockBalances' | 'post'>;
  readonly gate: BeneficiaryGate;
  /** commission readCommissionSnapshot (current commission_version). */
  readSnapshot(
    trx: Transaction<DB>,
    input: CreditSnapshotSelection,
  ): Promise<CreditSnapshot | null>;
  /** Writer of commission_split_beneficiary_events (same port as B2-04m). */
  appendBeneficiaryEvent(trx: Transaction<DB>, input: BeneficiaryEventInput): Promise<void>;
  readonly pending: {
    open(trx: Transaction<DB>, input: ClawbackPendingInput): Promise<void>;
  };
  /** settle.estimate_change_diff.enabled (default on; false / 'false' / 'off' turn it off). */
  readonly config: {
    get(appId: string, key: string): Promise<unknown>;
  };
  readonly events: Pick<EventBus, 'publish'>;
}

export type ClawbackSkipReason = 'not_credited' | 'not_reverse';

export type ClawbackResult =
  | {
      readonly outcome: 'clawed_back';
      readonly transition: 'R8' | 'R9';
      readonly orderKey: string;
      readonly rightsEventId: string;
      readonly bookedBaseFen: bigint;
      readonly bookedNFen: bigint;
    }
  | {
      /** Recalculated with nothing to write (e.g. a replayed R9 event). */
      readonly outcome: 'no_change';
      readonly orderKey: string;
      readonly rightsEventId: string;
    }
  | {
      readonly outcome: 'wait_commission';
      readonly orderKey: string;
      readonly rightsEventId: string;
    }
  | {
      /** R9b. registered: a recon diff was registered (or already existed for this estimate). */
      readonly outcome: 'estimate_archived';
      readonly orderKey: string;
      readonly reconDiff: 'registered' | 'none' | 'disabled';
    }
  | { readonly outcome: 'skipped'; readonly reason: ClawbackSkipReason };

export interface ClawbackOrder {
  apply(trx: Transaction<DB>, command: ClawbackCommand): Promise<ClawbackResult>;
  onUpdated(
    trx: Transaction<DB>,
    change: OrderUpdateChange,
    source: OrderStatusSource,
  ): Promise<ClawbackResult>;
}

export function createClawbackOrder(deps: ClawbackDependencies): ClawbackOrder {
  void deps;
  throw new Error('NotImplemented: createClawbackOrder');
}
