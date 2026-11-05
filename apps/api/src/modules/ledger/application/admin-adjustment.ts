// B2-12c skeleton (rule-test phase, implementation pending): manual balance adjustments of the admin
// console (contracts/openapi.yaml adminListAdjustments, adminGetAdjustment, adminCreateAdjustment;
// 08 BR-FUND-24 with 细则「红冲只按原单整笔」「后台入口」 and D10-590 ④, BR-FUND-10, BR-FUND-16;
// specs/ledger-templates.csv ADMIN_ADJUST:*). One submission saves and approves at once: the form is
// born APPROVED and its ADMIN_ADJUST voucher (`ADJ:{adjust_id}`, a reversal
// `ADJ:{original}:REVERSE` with the trusted voucher kind ADMIN_ADJUST_REV) is posted in the same
// transaction under the member's balance lock, with the audit record and, on a decrease, the
// member's in-app message.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { AuditPort, Clock, Idempotency } from '../../platform/index.ts';

export type AdminAdjustmentDirection = 'increase' | 'decrease';
export type AdminAdjustmentReasonCode =
  'RESTORE' | 'RECON_FIX' | 'PAYOUT_RECOVERY' | 'ACCOUNT_CLOSED' | 'OTHER';
export type AdminAdjustmentStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type AdminAdjustmentRefType = 'recon_diff' | 'withdrawal' | 'order' | 'account_deletion';

export interface AdminAdjustmentRef {
  readonly ref_type: AdminAdjustmentRefType;
  readonly ref_id: string;
}

/** GET /admin/v1/adjustments after the route schema (filters combine with AND). */
export interface AdminAdjustmentListQuery {
  readonly appId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly reasonCode: AdminAdjustmentReasonCode | null;
  readonly status: AdminAdjustmentStatus | null;
  readonly userId: string | null;
}

/** A new form of POST /admin/v1/adjustments after the route schema. */
export interface AdminAdjustmentNewInput {
  readonly kind: 'new';
  readonly userId: string;
  readonly direction: AdminAdjustmentDirection;
  readonly amountFen: bigint;
  readonly reasonCode: 'RECON_FIX' | 'PAYOUT_RECOVERY' | 'OTHER';
  readonly refs: readonly AdminAdjustmentRef[];
  readonly note: string | null;
  readonly contraSubject: string | null;
  readonly contraPlatform: string | null;
}

/** A whole-form reversal of POST /admin/v1/adjustments after the route schema. */
export interface AdminAdjustmentReversalInput {
  readonly kind: 'reversal';
  readonly reversesAdjustId: string;
  readonly note: string;
}

export interface AdminAdjustmentCreateRequest {
  readonly appId: string;
  /** admin_users.id of the caller (filer and reviewer of the form). */
  readonly adminId: string;
  readonly body: AdminAdjustmentNewInput | AdminAdjustmentReversalInput;
}

export interface AdminAdjustmentReadDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}

export interface AdminAdjustmentCreateDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  /** admin's audit writer bound to the submission's transaction. */
  readonly auditOn: (trx: Kysely<DB>) => AuditPort;
}

export function listAdminAdjustments(
  deps: AdminAdjustmentReadDeps,
  query: AdminAdjustmentListQuery,
): Promise<unknown> {
  void deps;
  void query;
  throw new Error('NotImplemented: listAdminAdjustments');
}

export function getAdminAdjustment(
  deps: AdminAdjustmentReadDeps,
  input: { readonly appId: string; readonly adjustId: string },
): Promise<unknown> {
  void deps;
  void input;
  throw new Error('NotImplemented: getAdminAdjustment');
}

export function createAdminAdjustment(
  deps: AdminAdjustmentCreateDeps,
  request: AdminAdjustmentCreateRequest,
): Promise<unknown> {
  void deps;
  void request;
  throw new Error('NotImplemented: createAdminAdjustment');
}
