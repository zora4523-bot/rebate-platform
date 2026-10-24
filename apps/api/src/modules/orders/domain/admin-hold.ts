// B1-09l: pure rules of the console's hold / unhold (POST /admin/v1/orders/{order_id}/hold and
// /unhold; contract adminHoldOrder / adminUnholdOrder; BR-FUND-06 细则「后台 hold / unhold」,
// BR-FUND-01 R11): the reason code derived from the operator's permission points (D10-152), the
// body check (reason_code RISK / CS only, note 1–200 characters) and the judgement over the order
// reread FOR UPDATE under its sub-order lock (R11 start state, same state, UNMAPPED_STATUS
// pending record still open, row_version; D10-155, D10-157). No Nest, no data access.
import type { OrderHoldReason } from '@couli/contracts-ts';

/** What an operator may send: RISK or CS (UNMAPPED_STATUS is set by the system alone). */
export type StaffHoldReason = Exclude<OrderHoldReason, 'UNMAPPED_STATUS'>;

export type AdminHoldMode = 'hold' | 'unhold';

/** The operator as the admin guard (is_super) and admin's permission read know them. */
export interface HoldOperator {
  readonly isSuper: boolean;
  /** Permission keys (specs/permissions.yaml) the account holds in its app. */
  readonly permissions: readonly string[];
}

/** The request body as received: reason_code may be missing or outside RISK / CS. */
export interface AdminHoldBody {
  readonly reason_code?: string | undefined;
  readonly note: string;
}

export type AdminHoldBodyCheck =
  | { readonly ok: true; readonly reasonCode: StaffHoldReason; readonly note: string }
  | { readonly ok: false; readonly fields: readonly string[] };

/** The orders columns the judgement reads (reread FOR UPDATE under the sub-order lock). */
export interface AdminHoldOrderState {
  readonly rebate_status: string;
  readonly hold: boolean;
  readonly hold_reason: string | null;
  readonly row_version: number;
}

/** 'conflict' is 20902 with data.resource=order: nothing is written. */
export type AdminHoldDecision = 'proceed' | 'conflict';

/**
 * D10-152: any `risk.*` point (risk.freeze, risk.ban, risk.blocklist, risk.appeal; config.risk
 * does not count) without order.claim → RISK; order.claim without `risk.*` → CS; both (a super
 * admin holds both) or neither → null (the operator picks one).
 */
export function deriveHoldReasonCode(operator: HoldOperator): StaffHoldReason | null {
  void operator;
  throw new Error('NotImplemented: deriveHoldReasonCode');
}

/** Hold: reason_code may be left out when derivable, must equal the derived one when sent. */
export function checkHoldBody(operator: HoldOperator, body: AdminHoldBody): AdminHoldBodyCheck {
  void operator;
  void body;
  throw new Error('NotImplemented: checkHoldBody');
}

/** Unhold: reason_code required (RISK or CS, the operator's choice). */
export function checkUnholdBody(body: AdminHoldBody): AdminHoldBodyCheck {
  void body;
  throw new Error('NotImplemented: checkUnholdBody');
}

/**
 * R11 only from ESTIMATED / WAITING; hold only when not held, unhold only when held and not an
 * UNMAPPED_STATUS hold whose BR-FUND-02 pending record is still open; row_version must match.
 */
export function decideAdminHold(
  mode: AdminHoldMode,
  order: AdminHoldOrderState,
  expectedRowVersion: number,
  unmappedPendingOpen: boolean,
): AdminHoldDecision {
  void mode;
  void order;
  void expectedRowVersion;
  void unmappedPendingOpen;
  throw new Error('NotImplemented: decideAdminHold');
}
