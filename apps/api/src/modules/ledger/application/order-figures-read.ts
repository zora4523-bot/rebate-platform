// B1-09p skeleton (BR-TEXT-02 金额字段, D10-558): one viewer's own entries on a batch of sub-orders,
// read only, by (app_id, order_key) on the structured column. Rule tests:
// test/spec/orders/figures/**.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface OrderFiguresLedgerSelection {
  readonly appId: string;
  readonly userId: string;
  readonly orderKeys: readonly string[];
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

export function readOrderFiguresLedger(
  db: Kysely<DB>,
  selection: OrderFiguresLedgerSelection,
): Promise<ReadonlyMap<string, OrderFiguresLedgerEntry>> {
  void db;
  void selection;
  throw new Error('NotImplemented: readOrderFiguresLedger');
}
