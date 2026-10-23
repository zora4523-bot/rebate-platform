// B2-04m: the single-order credit transaction (rebate transition R5, SETTLE_BATCH_CREDIT).
// BR-FUND-01 R5; BR-FUND-04 ⑦ ⑩ ⑫; BR-FUND-05; BR-FUND-16 细则「加锁流程」; BR-CALC-13.
//
// Everything runs on the caller's transaction (one PG transaction per sub-order, BR-FUND-04 ⑦);
// the service never opens, commits or rolls back a transaction itself. In order:
//   1. pg_advisory_xact_lock(order_key) — the same key as orders' lockOrderKey(platform, sub_order_id);
//   2. re-read the order after the lock: rebate_status = WAITING, hold = false,
//      rights_pending = false, and the greatest order_settlements seq = expectedSettleSeq;
//      otherwise return { outcome: 'skipped' } without writing anything;
//   3. read the commission snapshot (current commission_version) and its tlj_deduct_fen; a
//      tlj_deduct_fen > 0 skips with 'tlj_deduct_unsupported' plus an alert log and writes
//      nothing (编排裁定 D10-272); then lock the users rows of the beneficiaries through the
//      BeneficiaryGate (ascending user_id);
//   4. ledger.lockBalances for those users (ascending account_id);
//   5. re-read each beneficiary's state through the gate (after 3 and 4) and plan the credit with
//      @couli/domain planInitialCredit (B_credit from N per BR-CALC-02, shares per snapshot ratio);
//   6. buildVouchers per planned voucher and ledger.post each one (uniq_key per BR-FUND-05: a replay
//      is a duplicate, never a second credit);
//   7. held beneficiaries with a positive share: open one first_credit obligation each
//      (beneficiary_credits, opened_by R5, opened_ref = input.openedRef) and append a held event;
//      forfeited ones: append a forfeited event with the forfeit reason;
//   8. write booked_base_fen = B_credit and booked_n_fen = max(0, N) together, and move rebate_status
//      WAITING → CREDITED through the generated order-rebate transition() with a CAS on
//      (rebate_status, row_version); a CAS that matches no row throws (the caller's transaction then
//      rolls back as a whole); write the rebate history row;
//   9. publish order.credited on the same transaction.
// Amounts only through @couli/money; time only from the injected Clock.
// Skeleton: every function throws NotImplemented until implemented.
import type { DB } from '@couli/db';
import type { CreditForfeitReason } from '@couli/domain';
import type { Transaction } from 'kysely';
import type { Ledger } from '../../ledger/index.ts';
import type { Clock, EventBus, RootLogger } from '../../platform/index.ts';
import type { BeneficiaryGate } from './beneficiary-gate.ts';

export type CreditRole = 'self' | 'share' | 'direct' | 'indirect';

export interface CreditSnapshotSelection {
  readonly appId: string;
  readonly orderId: string;
  /** orders.commission_version: the snapshot's current version. */
  readonly commissionVersion: number;
}

export interface CreditSnapshotBeneficiary {
  readonly userId: string;
  readonly role: CreditRole;
  readonly ratioBp: number;
  readonly initialStatus: 'active' | 'forfeited';
}

/** Structurally compatible with commission's readCommissionSnapshot result (B2-04i). */
export interface CreditSnapshot {
  readonly reserveBp: number;
  readonly beneficiaries: readonly CreditSnapshotBeneficiary[];
  /** Every forfeited event of the order; a (user, role) listed here stays forfeited. */
  readonly forfeitedEvents: readonly { readonly userId: string; readonly role: CreditRole }[];
}

/** One beneficiary event of BR-CALC-13 (commission_split_beneficiary_events), same transaction. */
export interface BeneficiaryEventInput {
  readonly appId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly role: CreditRole;
  readonly status: 'held' | 'forfeited';
  /** forfeited: banned | deleted | minor; held: null. */
  readonly reason: CreditForfeitReason | null;
}

export interface CreditOrderDependencies {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly ledger: Pick<Ledger, 'openUserAccount' | 'lockBalances' | 'post'>;
  readonly gate: BeneficiaryGate;
  /** commission readCommissionSnapshot; null when the order has no snapshot (throws then). */
  readSnapshot(
    trx: Transaction<DB>,
    input: CreditSnapshotSelection,
  ): Promise<CreditSnapshot | null>;
  /** tlj_deduct_fen of the immutable snapshot (BR-CALC-02); not exported by commission yet. */
  readTljDeductFen(trx: Transaction<DB>, input: CreditSnapshotSelection): Promise<bigint>;
  /** Writer of commission_split_beneficiary_events (待编排裁定: commission owns the table). */
  appendBeneficiaryEvent(trx: Transaction<DB>, input: BeneficiaryEventInput): Promise<void>;
  readonly events: Pick<EventBus, 'publish'>;
}

export interface CreditOrderInput {
  readonly appId: string;
  readonly orderId: string;
  /** BR-FUND-04 ⑦: the order_settlements seq the batch was validated on. */
  readonly expectedSettleSeq: number;
  /** Opening reference of the first_credit obligations (the batch item); nonempty. */
  readonly openedRef: string;
}

/**
 * tlj_deduct_unsupported: the snapshot's tlj_deduct_fen is > 0. 淘礼金 is not credited this period
 * (编排裁定 D10-272): skip without writing anything and log a warn line with
 * alert = 'credit_tlj_deduct_unsupported', app_id and order_id; the batch item keeps the reason
 * (BR-FUND-04 ⑦).
 */
export type CreditSkipReason =
  'not_waiting' | 'hold' | 'rights_pending' | 'settlement_changed' | 'tlj_deduct_unsupported';

export interface CreditBeneficiaryOutcome {
  readonly userId: string;
  readonly role: CreditRole;
  readonly shareFen: bigint;
  readonly action: 'credit' | 'held' | 'forfeited';
  readonly forfeitReason: CreditForfeitReason | null;
  /** The first_credit obligation opened for a held beneficiary, else null. */
  readonly beneficiaryCreditId: string | null;
}

export type CreditOrderResult =
  | {
      readonly outcome: 'credited';
      readonly orderKey: string;
      readonly bCreditFen: bigint;
      readonly bookedNFen: bigint;
      /** Platform retain + reserve (the PLATFORM:CREDIT voucher; 0 when none was written). */
      readonly platformCreditFen: bigint;
      readonly beneficiaries: readonly CreditBeneficiaryOutcome[];
    }
  | { readonly outcome: 'skipped'; readonly reason: CreditSkipReason };

export interface CreditOrder {
  /**
   * Credits one WAITING sub-order on the caller's transaction (see the file header). An order or
   * snapshot that does not exist for input.appId throws and writes nothing.
   */
  credit(trx: Transaction<DB>, input: CreditOrderInput): Promise<CreditOrderResult>;
}

export function createCreditOrder(deps: CreditOrderDependencies): CreditOrder {
  void deps;
  throw new Error('NotImplemented: createCreditOrder');
}
