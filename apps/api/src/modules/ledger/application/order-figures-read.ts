// B1-09p (BR-TEXT-02 金额字段, D10-558): one viewer's own entries on a batch of sub-orders, by
// (app_id, order_key) on the structured column, summed per voucher kind. Only the three kinds of the
// BR-TEXT-02 formula count: RESTORE and the reassignment vouchers stay out until that gap is ruled
// on. Both sub-accounts of the viewer's USER_BALANCE; a SELECT on the handle it is given.
import type { DB } from '@couli/db';
import { addFen, subFen } from '@couli/money';
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

/** One entry on the viewer's account; amount_fen is stored debit positive, credit negative. */
export interface OrderFiguresEntryRow {
  readonly order_key: string | null;
  readonly voucher_kind: string | null;
  readonly amount_fen: bigint;
  readonly booked_at: Date;
}

const VOUCHER_KINDS = ['CREDIT', 'SETTLE_ADJUST', 'CLAWBACK'];
const EMPTY: OrderFiguresLedgerEntry = {
  credited_fen: 0n,
  settle_adjust_fen: 0n,
  clawback_fen: 0n,
  last_clawback_at: null,
};

function later(current: Date | null, candidate: Date): Date {
  return current === null || candidate.getTime() > current.getTime() ? candidate : current;
}

function added(entry: OrderFiguresLedgerEntry, row: OrderFiguresEntryRow): OrderFiguresLedgerEntry {
  const userSide = subFen(0n, row.amount_fen);
  if (row.voucher_kind === 'CREDIT') {
    return { ...entry, credited_fen: addFen(entry.credited_fen, userSide) };
  }
  if (row.voucher_kind === 'SETTLE_ADJUST') {
    return { ...entry, settle_adjust_fen: addFen(entry.settle_adjust_fen, userSide) };
  }
  if (row.voucher_kind === 'CLAWBACK') {
    const size = row.amount_fen < 0n ? userSide : row.amount_fen;
    return {
      ...entry,
      clawback_fen: addFen(entry.clawback_fen, size),
      last_clawback_at: later(entry.last_clawback_at, row.booked_at),
    };
  }
  return entry;
}

/** Sums per order_key; an order without an entry is left out. */
export function aggregateOrderFigures(
  rows: readonly OrderFiguresEntryRow[],
): ReadonlyMap<string, OrderFiguresLedgerEntry> {
  const found = new Map<string, OrderFiguresLedgerEntry>();
  for (const row of rows) {
    if (row.order_key === null) continue;
    found.set(row.order_key, added(found.get(row.order_key) ?? EMPTY, row));
  }
  return found;
}

export async function readOrderFiguresLedger(
  db: Kysely<DB>,
  selection: OrderFiguresLedgerSelection,
): Promise<ReadonlyMap<string, OrderFiguresLedgerEntry>> {
  if (selection.orderKeys.length === 0) return new Map();
  const rows = await db
    .withSchema('app')
    .selectFrom('ledger_vouchers as v')
    .innerJoin('ledger_entries as e', (join) =>
      join.onRef('e.app_id', '=', 'v.app_id').onRef('e.voucher_id', '=', 'v.id'),
    )
    .innerJoin('ledger_accounts as a', (join) =>
      join.onRef('a.app_id', '=', 'e.app_id').onRef('a.id', '=', 'e.account_id'),
    )
    .select(['v.order_key', 'v.voucher_kind', 'e.amount_fen', 'e.booked_at'])
    .where('v.app_id', '=', selection.appId)
    .where('v.order_key', 'in', [...new Set(selection.orderKeys)])
    .where('v.voucher_kind', 'in', VOUCHER_KINDS)
    .where('a.owner_type', '=', 'user')
    .where('a.owner_id', '=', selection.userId)
    .where('a.subject', '=', 'USER_BALANCE')
    .execute();
  return aggregateOrderFigures(rows);
}
