// B1-09p skeleton (D10-551 item 9, D10-558): the per-order figures behind orders' OrderFiguresReader,
// one viewer at a time. Read only. The implementation reuses pending-earnings-rules, so its amounts
// are the wallet's; it does not go through createPendingEarningsSource.forUser.
// Rule tests: test/spec/orders/figures/**.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { PendingEarningsDependencies } from './pending-earnings.ts';

export interface OrderFiguresSubject {
  readonly app_id: string;
  readonly user_id: string;
}

/** Same fields as orders' OrderFigures; settlement does not import orders. */
export interface OrderFiguresValue {
  readonly b_est: bigint | null;
  readonly est_rebate_fen: bigint | null;
  readonly actual_fen: bigint | null;
  readonly clawback_fen: bigint | null;
  readonly has_clawback: boolean;
  readonly part_clawed_at: string | null;
  readonly viewer_share_held: boolean;
  readonly expected_credit_period: string | null;
  readonly credit_overdue: boolean;
  readonly appeal_pending: boolean;
}

export interface OrderFiguresSource {
  forOrders(
    subject: OrderFiguresSubject,
    orderIds: readonly string[],
  ): Promise<ReadonlyMap<string, OrderFiguresValue>>;
}

/** One order on the viewer's own account; amounts as the user sees them, in whole fen. */
export interface OrderFiguresLedgerEntry {
  readonly credited_fen: bigint;
  /** Σ SETTLE_ADJUST, signed from the user's side: a positive adjustment adds to the balance. */
  readonly settle_adjust_fen: bigint;
  /** Σ |CLAWBACK|. */
  readonly clawback_fen: bigint;
  /** booked_at of the latest CLAWBACK (D10-558 ②), null without one. */
  readonly last_clawback_at: Date | null;
}

export interface OrderFiguresLedgerSelection {
  readonly appId: string;
  readonly userId: string;
  readonly orderKeys: readonly string[];
}

/** ledger's read port; orders without an entry on the account are left out of the map. */
export type OrderFiguresLedgerRead = (
  db: Kysely<DB>,
  selection: OrderFiguresLedgerSelection,
) => Promise<ReadonlyMap<string, OrderFiguresLedgerEntry>>;

/** risk's read port. */
export interface OrderFiguresAppealRead {
  /** The given orders of the app with a processing order appeal of the user. */
  pendingOrderIds(
    appId: string,
    userId: string,
    orderIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
}

export interface OrderFiguresDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly config: PendingEarningsDependencies['config'];
  readonly readSnapshot: PendingEarningsDependencies['readSnapshot'];
  readonly readTljDeductFen: PendingEarningsDependencies['readTljDeductFen'];
  readonly ledger: OrderFiguresLedgerRead;
  readonly appeals: OrderFiguresAppealRead;
}

export function createOrderFiguresReader(deps: OrderFiguresDependencies): OrderFiguresSource {
  void deps;
  throw new Error('NotImplemented: createOrderFiguresReader');
}
