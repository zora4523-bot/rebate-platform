// B1-10i: pure rules of the console's order reads (GET /admin/v1/orders, GET
// /admin/v1/orders/{order_id}; contract adminListOrders / adminGetOrder, CT-24m, CT-24n): the
// flags of a row (status_locked derived from rebate_status), the q normalization, the derived
// unmapped_pending_open and the latest manual hold (方案 K-7). No Nest, no data access.
import type { Schema } from '@couli/contracts-ts';

/** The orders columns a row's flags come from. */
export interface AdminOrderFlagSource {
  readonly locked: boolean;
  readonly rights_pending: boolean;
  readonly hold: boolean;
  readonly rebate_status: string;
}

/** One BR-FUND-02 pending record of the same sub-order (order_sync_pending reason and status). */
export interface AdminOrderPendingRecord {
  readonly reason: string;
  readonly status: string;
}

/** The latest manual hold audit record of the order (action order_hold): admin, note and time. */
export interface AdminOrderHoldAudit {
  readonly admin_id: string;
  readonly note: string | null;
  readonly at: Date;
}

export type AdminOrderLastHold = Pick<
  Schema<'AdminOrderDetail'>,
  'last_hold_by' | 'last_hold_by_name' | 'last_hold_note' | 'last_hold_at'
>;

/** locked, rights_pending, hold as stored; status_locked: rebate_status VOID, CREDITED, CLAWED_BACK. */
export function adminOrderFlags(row: AdminOrderFlagSource): Schema<'AdminOrderFlags'> {
  void row;
  throw new Error('NotImplemented: adminOrderFlags');
}

/** q trimmed and with inner spaces removed; null unless 1–64 characters remain. */
export function normalizeOrderQuery(raw: string): string | null {
  void raw;
  throw new Error('NotImplemented: normalizeOrderQuery');
}

/** hold_reason UNMAPPED_STATUS and an UNMAPPED_STATUS record of the sub-order still open. */
export function unmappedPendingOpen(
  holdReason: string | null,
  pending: readonly AdminOrderPendingRecord[],
): boolean {
  void holdReason;
  void pending;
  throw new Error('NotImplemented: unmappedPendingOpen');
}

/** The four last_hold_* fields; all null when never held by hand or held by the system now. */
export function lastManualHold(
  holdReason: string | null,
  audit: AdminOrderHoldAudit | null,
  name: string | null,
): AdminOrderLastHold {
  void holdReason;
  void audit;
  void name;
  throw new Error('NotImplemented: lastManualHold');
}
