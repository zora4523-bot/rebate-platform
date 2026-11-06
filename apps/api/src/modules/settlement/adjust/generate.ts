// B2-09zb (FU-SETTLE-ADJ-POSITIVE; 08 BR-FUND-09 ②, BR-CALC-02, BR-CALC-09; D10-769, D10-770,
// D10-780): R1's positive-difference candidate run of one app and platform. Skeleton of the rule-test
// round; the contract below is what test/spec/settlement/settle-adjust-generate/** pins.
//
// run({ appId, platform, accountingDate }):
//   - scope: the app's orders of `platform` with rebate_status CREDITED; the current settlement is
//     orders.settle_commission_fen (latest STATEMENT, else latest API) and the current seq the
//     greatest order_settlements seq of the order;
//   - per order, on its own transaction (all of its rows or none): order key lock, users, the
//     beneficiaries' states after the locks, the nets from ledger, the snapshot's reserve_bp and
//     ratios; @couli/domain planCommissionAdjustment({ event: 'settlement', … }); only the
//     `approval` route (positive difference) is written, `immediate` and `none` are left alone;
//   - 决-10 A: while settle.adjust.void_on_clawback.enabled is on (the default; false / 'false' /
//     'off' turn it off) an order is only taken when its current settlement record was written
//     after the order's latest CLAWBACK;
//   - rows: one settle_adjust_batches row per run that writes at least one candidate (never an
//     empty batch; confirmed_* null), one settle_adjustments row per beneficiary with a positive
//     difference (status pending, settle_seq the current seq, commission_version the order's
//     current one; a frozen / appealing beneficiary's row as usual; a banned or deleting / deleted
//     beneficiary's share is in the platform row) and one platform row (user_id, role null) when
//     its difference is not 0; no voucher, no balance, no booked pair, no event;
//   - D10-780: pending rows of the same order and seq at another commission_version become
//     voided_stale_seq (reason superseded_by_version, decided_at the Clock) on the same transaction
//     before the new rows, with one system audit record (action
//     settle_adjust_candidate_superseded: the order, the old and the new version); pending rows of
//     the same version, and approved / rejected rows of the same version, make the order a skip.
// Result: batchId (null when nothing was written), orders (orders that got candidates), candidates
// (rows written), superseded (rows voided by a version change).
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { OrderNetSelection, OrderNets } from '../../ledger/index.ts';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { BeneficiaryGate, CreditSnapshot, CreditSnapshotSelection } from '../credit/index.ts';

/** One system audit record (the shape of admin's SystemActionAudit; actor system:settlement). */
export interface SettleAdjustAuditInput {
  readonly appId: string;
  readonly actor: 'system:settlement';
  readonly action: string;
  readonly target: string;
  readonly before: Readonly<Record<string, string | number | boolean | null>>;
  readonly after: Readonly<Record<string, string | number | boolean | null>>;
}

/** admin's system audit writer on the caller's transaction (createSystemAuditWriter, by shape). */
export interface SettleAdjustAudit {
  appendAction(trx: Transaction<DB>, input: SettleAdjustAuditInput): Promise<void>;
}

export interface SettleAdjustGeneratorDependencies {
  /** Each order runs on its own transaction opened here. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly gate: BeneficiaryGate;
  /** commission readCommissionSnapshot (current commission_version). */
  readSnapshot(
    trx: Transaction<DB>,
    input: CreditSnapshotSelection,
  ): Promise<CreditSnapshot | null>;
  /** ledger getOrderNets. */
  readOrderNets(trx: Transaction<DB>, input: OrderNetSelection): Promise<OrderNets>;
  /** content's configuration reader (settle.adjust.void_on_clawback.enabled). */
  readonly config: { get(appId: string, key: string): Promise<unknown> };
  readonly audit: SettleAdjustAudit;
}

export interface SettleAdjustRunInput {
  readonly appId: string;
  readonly platform: string;
  /** The +08:00 day D of the run (YYYY-MM-DD). */
  readonly accountingDate: string;
}

export interface SettleAdjustRunResult {
  readonly batchId: string | null;
  readonly orders: number;
  readonly candidates: number;
  readonly superseded: number;
}

export interface SettleAdjustGenerator {
  run(input: SettleAdjustRunInput): Promise<SettleAdjustRunResult>;
}

export function createSettleAdjustGenerator(
  deps: SettleAdjustGeneratorDependencies,
): SettleAdjustGenerator {
  void deps;
  throw new Error('NotImplemented: createSettleAdjustGenerator');
}
