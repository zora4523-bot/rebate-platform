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

const STAFF_REASONS: ReadonlySet<string> = new Set<StaffHoldReason>(['RISK', 'CS']);
/** R11 start states (BR-FUND-01): hold and unhold are both possible only here. */
const R11_FROM: ReadonlySet<string> = new Set(['ESTIMATED', 'WAITING']);
const UNMAPPED_STATUS: OrderHoldReason = 'UNMAPPED_STATUS';
/** Contract: note 1–200 characters, counted as code points (not UTF-16 units). */
const NOTE_MAX = 200;

function isStaffReason(value: string | undefined): value is StaffHoldReason {
  return value !== undefined && STAFF_REASONS.has(value);
}

function noteOk(note: string): boolean {
  const length = [...note].length;
  return length >= 1 && length <= NOTE_MAX;
}

/**
 * D10-152: any `risk.*` point (risk.freeze, risk.ban, risk.blocklist, risk.appeal; config.risk
 * does not count) without order.claim → RISK; order.claim without `risk.*` → CS; both (a super
 * admin holds both) or neither → null (the operator picks one).
 */
export function deriveHoldReasonCode(operator: HoldOperator): StaffHoldReason | null {
  if (operator.isSuper) return null;
  const risk = operator.permissions.some((key) => key.startsWith('risk.'));
  const claim = operator.permissions.includes('order.claim');
  if (risk && !claim) return 'RISK';
  if (claim && !risk) return 'CS';
  return null;
}

/** Hold: reason_code may be left out when derivable, must equal the derived one when sent. */
export function checkHoldBody(operator: HoldOperator, body: AdminHoldBody): AdminHoldBodyCheck {
  const derived = deriveHoldReasonCode(operator);
  const sent = body.reason_code;
  let reasonCode: StaffHoldReason;
  if (sent === undefined) {
    if (derived === null) return { ok: false, fields: ['reason_code'] };
    reasonCode = derived;
  } else {
    if (!isStaffReason(sent) || (derived !== null && sent !== derived)) {
      return { ok: false, fields: ['reason_code'] };
    }
    reasonCode = sent;
  }
  if (!noteOk(body.note)) return { ok: false, fields: ['note'] };
  return { ok: true, reasonCode, note: body.note };
}

/** Unhold: reason_code required (RISK or CS, the operator's choice). */
export function checkUnholdBody(body: AdminHoldBody): AdminHoldBodyCheck {
  const sent = body.reason_code;
  if (!isStaffReason(sent)) return { ok: false, fields: ['reason_code'] };
  if (!noteOk(body.note)) return { ok: false, fields: ['note'] };
  return { ok: true, reasonCode: sent, note: body.note };
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
  if (!R11_FROM.has(order.rebate_status)) return 'conflict';
  if (order.row_version !== expectedRowVersion) return 'conflict';
  if (mode === 'hold') return order.hold ? 'conflict' : 'proceed';
  if (!order.hold) return 'conflict';
  if (order.hold_reason === UNMAPPED_STATUS && unmappedPendingOpen) return 'conflict';
  return 'proceed';
}
