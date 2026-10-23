// B2-04q: execution of one beneficiary credit item (受益人补记项, rebate self-transition R5a
// BENEFICIARY_RELEASE). BR-FUND-01 R5a; BR-FUND-04 ⑫; BR-FUND-19 ⑤; BR-CALC-13; lock flow of
// BR-FUND-16 细则「加锁流程」 (same as B2-04m).
//
// Skeleton only (test phase): every function throws NotImplemented. The contract the rule tests in
// test/spec/settlement/beneficiary-credit/** hold the implementation to:
//
// Everything runs on the caller's transaction (one PG transaction per batch item); the service never
// opens, commits or rolls back a transaction itself. In order:
//   1. pg_advisory_xact_lock(order_key) through orders' lockOrderKey(platform, sub_order_id);
//   2. after the lock, re-read the order and the obligation (beneficiary_credits) and re-verify:
//      rebate_status = CREDITED, rights_pending = false, the greatest order_settlements seq =
//      input.expectedSettleSeq, the obligation's split_ref = the order's current snapshot reference
//      (`commission_version:{orders.commission_version}`, as B2-04m writes it) and the obligation
//      status = open; a failed check returns { outcome: 'skipped', reason } and writes nothing;
//   3. lock the obligation's beneficiary users row through the BeneficiaryGate, then
//      ledger.lockBalances for that user, then re-read the beneficiary's state through the gate;
//   4. check BR-FUND-19 ⑤ for the whole order before writing (ledger order nets, the snapshot
//      ratios, the order's open obligations, booked_base_fen / booked_n_fen); when it does not hold,
//      skip with 'invariant_mismatch', write nothing and log a warn line with
//      alert = BeneficiaryCreditAlert, app_id, order_id and beneficiary_credit_id;
//   5. amount = the obligation's remaining amount at execution time: max(0, floor(booked_base_fen ×
//      ratio_bp / 10000) − the beneficiary's net), never the snapshot's base_fen;
//   6. by obligation kind and the re-read state (BR-CALC-13):
//      - normal (cooling-off deletion included; a minor's own self share included):
//        first_credit → `{order_key}:{uid}:{role}:CREDIT`; deferred →
//        `{order_key}:{uid}:{role}:ADJ:DEFERRED:{beneficiary_credit_id}` with the ledger type and
//        sub type the obligation was opened with (origin_ledger_type / origin_sub_type);
//        obligation open → done (COMPLETE);
//      - banned, deletion processing / done, minor (promotion shares only) → forfeit with its
//        forfeit_reason: first_credit → `{order_key}:PLATFORM:FORFEIT:{uid}:{role}` plus a forfeited
//        beneficiary event; deferred → `{order_key}:PLATFORM:FORFEIT:{uid}:{role}:DEFERRED:
//        {beneficiary_credit_id}`, no event; obligation open → forfeited (FORFEIT);
//      - frozen / appealing → { outcome: 'deferred' }: no voucher, obligation stays open;
//      an amount of 0 writes no voucher and still closes the obligation (voucher_id null);
//   7. the obligation is closed through the generated beneficiary-credit transition() with a CAS on
//      (status, row_version), row_version + 1, closed_by = 'R5a', closed_ref = input.closedRef,
//      closed_at = the injected Clock, voucher_id = the voucher written (null when none), on the
//      same transaction as the voucher.
// Amounts only through @couli/money; time only from the injected Clock.
import type { DB } from '@couli/db';
import type { CreditForfeitReason } from '@couli/domain';
import type { Transaction } from 'kysely';
import type { Ledger, OrderNetSelection, OrderNets } from '../../../ledger/index.ts';
import type { Clock, RootLogger } from '../../../platform/index.ts';
import type { BeneficiaryGate } from '../beneficiary-gate.ts';
import type {
  BeneficiaryEventInput,
  CreditRole,
  CreditSnapshot,
  CreditSnapshotSelection,
} from '../credit-order.ts';

export interface BeneficiaryCreditDependencies {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly ledger: Pick<Ledger, 'openUserAccount' | 'lockBalances' | 'post'>;
  readonly gate: BeneficiaryGate;
  /** commission readCommissionSnapshot (current commission_version); null when there is none. */
  readSnapshot(
    trx: Transaction<DB>,
    input: CreditSnapshotSelection,
  ): Promise<CreditSnapshot | null>;
  /** ledger getOrderNets: beneficiary nets and the ⑤ UNION_RECEIVABLE net of the order. */
  readOrderNets(trx: Transaction<DB>, input: OrderNetSelection): Promise<OrderNets>;
  /** Writer of commission_split_beneficiary_events (same as B2-04m). */
  appendBeneficiaryEvent(trx: Transaction<DB>, input: BeneficiaryEventInput): Promise<void>;
}

export interface BeneficiaryCreditInput {
  readonly appId: string;
  readonly orderId: string;
  /** The obligation the batch item refers to (settle_batch_items.beneficiary_credit_id). */
  readonly beneficiaryCreditId: string;
  /** settle_batch_items.settle_seq: the order_settlements seq when the item was generated. */
  readonly expectedSettleSeq: number;
  /** closed_ref written when this execution closes the obligation (the batch item id); nonempty. */
  readonly closedRef: string;
}

export type BeneficiaryCreditSkipReason =
  | 'not_credited'
  | 'rights_pending'
  | 'settlement_changed'
  | 'snapshot_changed'
  | 'obligation_closed'
  | 'invariant_mismatch';

/** The alert field of the warn line logged when BR-FUND-19 ⑤ does not hold before execution. */
export type BeneficiaryCreditAlert = 'beneficiary_credit_invariant_mismatch';

export type BeneficiaryCreditResult =
  | {
      readonly outcome: 'credited';
      readonly beneficiaryCreditId: string;
      readonly userId: string;
      readonly role: CreditRole;
      /** The remaining amount credited (0: no voucher, obligation done all the same). */
      readonly amountFen: bigint;
      /** ledger_vouchers.id of the voucher written, null when the amount was 0. */
      readonly voucherId: string | null;
    }
  | {
      readonly outcome: 'forfeited';
      readonly beneficiaryCreditId: string;
      readonly userId: string;
      readonly role: CreditRole;
      readonly amountFen: bigint;
      readonly forfeitReason: CreditForfeitReason;
      readonly voucherId: string | null;
    }
  | {
      readonly outcome: 'deferred';
      readonly beneficiaryCreditId: string;
      readonly userId: string;
      readonly role: CreditRole;
      /** The remaining amount at execution time (kept on the batch item; nothing written). */
      readonly amountFen: bigint;
    }
  | { readonly outcome: 'skipped'; readonly reason: BeneficiaryCreditSkipReason };

export interface BeneficiaryCredit {
  /**
   * Executes one beneficiary credit item on the caller's transaction (see the file header). An
   * order or obligation that does not exist for input.appId / input.orderId throws and writes
   * nothing.
   */
  execute(trx: Transaction<DB>, input: BeneficiaryCreditInput): Promise<BeneficiaryCreditResult>;
}

export function createBeneficiaryCredit(deps: BeneficiaryCreditDependencies): BeneficiaryCredit {
  void deps;
  throw new Error('NotImplemented: createBeneficiaryCredit');
}
