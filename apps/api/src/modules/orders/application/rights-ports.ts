import type { OrderHoldReason, OrderRightsStatus, OrderRightsType } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';

/** Settlement owns these outcomes, the guards, CAS, history, audit and all fund writes. */
export type RightsRecordResult = { readonly kind: 'applied' | 'duplicate' | 'not_applicable' };
export type AdminHoldResult = {
  readonly kind: 'applied' | 'not_applicable' | 'same_state' | 'cas_conflict';
};

export interface RightsRecordInput {
  /** Caller holds lockOrderKey and has reread this row FOR UPDATE in trx. */
  readonly before: Selectable<DB['orders']>;
  readonly order_id: string;
  readonly source: 'API' | 'IMPORT';
  readonly type: OrderRightsType;
  readonly status: OrderRightsStatus;
  readonly amount_fen: bigint | null;
  readonly deduction_commission_fen: bigint | null;
  readonly occurred_at: Date;
  readonly platform_rights_no: string | null;
  /** Injected Clock instant, distinct from the platform's occurred_at. */
  readonly now: Date;
}

export interface AdminHoldInput {
  /** Caller holds lockOrderKey and has reread this row FOR UPDATE in trx. */
  readonly before: Selectable<DB['orders']>;
  readonly expected_row_version: number;
  readonly reason_code: Exclude<OrderHoldReason, 'UNMAPPED_STATUS'>;
  /** Required operator explanation for the settlement audit. */
  readonly reason: string;
  /** Authenticated admin id, injected by the caller; never a system unhold. */
  readonly actor: string;
  readonly ip: string | null;
  readonly now: Date;
}

export interface RightsCommandPort {
  /** K-2: dedupe by (app_id, order_id, type, platform_rights_no), NULLS NOT DISTINCT. */
  record(trx: Transaction<DB>, input: RightsRecordInput): Promise<RightsRecordResult>;
}

export interface RebateAdminCommandPort {
  adminHold(trx: Transaction<DB>, input: AdminHoldInput): Promise<AdminHoldResult>;
  adminUnhold(trx: Transaction<DB>, input: AdminHoldInput): Promise<AdminHoldResult>;
}

export interface OrderRightsPorts {
  readonly rights?: RightsCommandPort;
  readonly rebate?: Partial<RebateAdminCommandPort>;
}

/**
 * Thin injection points, not transaction owners: no queries, writes, retries or fund guards.
 * Missing method throws ORDERS_RIGHTS_PORT_UNAVAILABLE: <port name> before any side effect.
 * Port failures propagate to the caller for rollback; successful outcomes pass through intact.
 */
export async function recordOrderRights(
  trx: Transaction<DB>,
  ports: OrderRightsPorts | undefined,
  input: RightsRecordInput,
): Promise<RightsRecordResult> {
  void trx;
  void ports;
  void input;
  throw new Error('NotImplemented: recordOrderRights');
}

export async function adminHoldOrder(
  trx: Transaction<DB>,
  ports: OrderRightsPorts | undefined,
  input: AdminHoldInput,
): Promise<AdminHoldResult> {
  void trx;
  void ports;
  void input;
  throw new Error('NotImplemented: adminHoldOrder');
}

export async function adminUnholdOrder(
  trx: Transaction<DB>,
  ports: OrderRightsPorts | undefined,
  input: AdminHoldInput,
): Promise<AdminHoldResult> {
  void trx;
  void ports;
  void input;
  throw new Error('NotImplemented: adminUnholdOrder');
}
