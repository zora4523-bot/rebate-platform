// B2-12d skeleton (contracts/openapi.yaml adminApproveAdjustment, adminRejectAdjustment; 08
// BR-FUND-24 ①⑥⑧, 细则「驳回与撤回不需二次验证」「注销调减单被驳回与注销中的调账」; D10-590 ③⑦):
// the system-prefilled ACCOUNT_CLOSED decrease of a deletion — its prefill, the closing gate the
// deletion completion asks, and its approval / rejection on the admin console. Only declarations
// that throw NotImplemented; the implementation follows in the implementation round.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { IdempotentResponse } from '../../platform/index.ts';
import type { AdminAdjustmentCreateDeps } from './admin-adjustment.ts';

/** identity's ClosingAdjustmentState (none_needed / pending / done). */
export type ClosingAdjustmentGateState = 'none_needed' | 'pending' | 'done';

export interface ClosingAdjustmentSubject {
  readonly appId: string;
  readonly userId: string;
}

export interface ClosingAdjustmentPrefillRequest extends ClosingAdjustmentSubject {
  /** deletion_requests.id, the form's one ref (ref_type account_deletion). */
  readonly deletionRequestId: string;
  readonly at: Date;
}

/** POST /admin/v1/adjustments/{adjust_id}/approve after the route schema and the guard. */
export interface AdminAdjustmentApproveRequest {
  readonly appId: string;
  /** admin_users.id of the caller (reviewer of the form). */
  readonly adminId: string;
  readonly ip: string | null;
  readonly adjustId: string;
  /** The raw request body (the idempotency hash). */
  readonly rawBody: unknown;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

/** POST /admin/v1/adjustments/{adjust_id}/reject after the route schema and the guard. */
export interface AdminAdjustmentRejectRequest extends AdminAdjustmentApproveRequest {
  /** The reason as sent (trimmed and checked here: 1–200 characters). */
  readonly reason: string;
}

/**
 * Inserts the PENDING ACCOUNT_CLOSED decrease of the member on the caller's transaction (users row
 * locked): no amount, no filer, contra COMMISSION_REVENUE, refs the deletion request; an existing
 * PENDING one is kept (partial unique key).
 */
export function prefillClosingAdjustment(
  trx: Transaction<DB>,
  input: ClosingAdjustmentPrefillRequest,
): Promise<{ readonly created: boolean }> {
  void trx;
  void input;
  throw new Error('NotImplemented: prefillClosingAdjustment');
}

/**
 * The closing gate on the caller's transaction (users row locked): available 0 and no PENDING
 * ACCOUNT_CLOSED form → done (an APPROVED one exists) or none_needed; anything else → pending.
 */
export function closingAdjustmentGate(
  trx: Transaction<DB>,
  input: ClosingAdjustmentSubject,
): Promise<ClosingAdjustmentGateState> {
  void trx;
  void input;
  throw new Error('NotImplemented: closingAdjustmentGate');
}

/** adminApproveAdjustment under platform idempotency: the exact bytes to send. */
export function approveAdminAdjustment(
  deps: AdminAdjustmentCreateDeps,
  request: AdminAdjustmentApproveRequest,
): Promise<IdempotentResponse> {
  void deps;
  void request;
  throw new Error('NotImplemented: approveAdminAdjustment');
}

/** adminRejectAdjustment under platform idempotency: the exact bytes to send. */
export function rejectAdminAdjustment(
  deps: AdminAdjustmentCreateDeps,
  request: AdminAdjustmentRejectRequest,
): Promise<IdempotentResponse> {
  void deps;
  void request;
  throw new Error('NotImplemented: rejectAdminAdjustment');
}
