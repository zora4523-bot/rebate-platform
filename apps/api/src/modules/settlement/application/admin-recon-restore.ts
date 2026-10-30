// B2-09g skeleton of the test stage: POST /admin/v1/recon-diffs/{recon_diff_id}/restore (contracts/
// openapi.yaml restoreAdminReconDiff, CT-24ze; 08 BR-FUND-22 ③, BR-CALC-09, BR-CALC-13; 编排裁定
// D10-468 ①, D10-469 ① ② ③). The rule tests in test/spec/settlement/admin-recon-restore/** reach it
// over the admin entry only; the controller (http/admin/) authorises through the AdminOperationGuard
// (order.restore, step-up tier totp), takes the parameters and calls restoreAdminReconDiff.
//
// restoreAdminReconDiff runs under platform idempotency in its transactional mode (subject
// a:<admin_users.id>, the concrete path, the Idempotency-Key header); 2xxxx refusals are not stored.
// On the claim's transaction, in the contract's order of checks, then for each role listed in
// resolution.shares: the member's active beneficiary event (commission's appendBeneficiaryEvent);
// floor(booked_base_fen × ratio_bp / 10000) less the role's net (ledger getOrderNets, BR-FUND-08);
// a positive difference posts ADMIN_ADJUST:RESTORE:APPEAL with uniq_key
// `{order_key}:{user_id}:{role}:RESTORE:{recon_diff_id}`. Then the difference to adjusted through a
// ledger command and the audit record recon_diff_restore. Locks: order key advisory lock, then the
// difference's row, the users row and ledger.lockBalances. Any failure rolls everything back.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { AuditPort, Clock, Idempotency, IdempotentResponse } from '../../platform/index.ts';

/** The data.reason of a 20001 [recon_diff_id] on a difference that cannot be restored here. */
export type ReconDiffRestoreRefusal = 'restore_not_supported' | 'restore_user_deleted';

export interface RestoreAdminReconDiffDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  /** admin's audit writer bound to the restore transaction (the single writer of audit_logs). */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
}

/** The guard's verified admin account and the request's address (for the audit row). */
export interface ReconDiffRestoreOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface ReconDiffRestoreRequest {
  readonly body: Schema<'AdminReconDiffRestoreRequest'>;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

/** Handles one account-appeal restore difference of the operator's app (BR-FUND-22 ③). */
export function restoreAdminReconDiff(
  deps: RestoreAdminReconDiffDeps,
  operator: ReconDiffRestoreOperator,
  reconDiffId: string,
  request: ReconDiffRestoreRequest,
): Promise<IdempotentResponse> {
  void deps;
  void operator;
  void reconDiffId;
  void request;
  throw new Error('NotImplemented: restoreAdminReconDiff');
}
