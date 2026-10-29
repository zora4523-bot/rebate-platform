// B2-09b skeleton (rule-test phase, claude-independent, SPEC_REF 37808a50): POST
// /admin/v1/recon-diffs/{recon_diff_id}/close (contracts/openapi.yaml closeAdminReconDiff; 08
// BR-FUND-19 差错单关闭时解除冻结记录, BR-FUND-22 「已关闭（不处理）」, BR-WDR-05 冻结记录逐条解除).
// Every function throws NotImplemented; the rule tests in test/spec/ledger/admin-recon-close/**
// go through the admin entry and do not import this file, so the shape below may be refined.
//
// Intended flow (task brief §9):
//   - Under platform idempotency (subject a:<admin_users.id>, standard mode), the exact bytes to
//     send come back as an IdempotentResponse, as payment's createPayRefund does.
//   - One transaction: the recon_diffs row of the app (source R1–R3) FOR UPDATE; status open or
//     processing, else 20902 data.resource=recon_diff; a CAS update to closed (handler_id the
//     caller, closed_at = updated_at = the injected Clock, resolution.reason the trimmed reason);
//     then `holds.releaseBySource(trx, { appId, sourceRef: 'recon_diff:<id>', releasedBy })`
//     (payout is the single writer of withdraw_holds and locks the users rows first, BR-WDR-07);
//     then the audit recon_diff_close on the same transaction (admin's writer bound to trx).
//   - ledger does not import payout: ReconDiffHoldRelease is the port app.module wires to payout's
//     releaseWithdrawHoldsBySource (payout/application/withdraw-holds.ts).
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { AuditPort, Clock, Idempotency, IdempotentResponse } from '../../platform/index.ts';

/** The payout port: releases every unreleased hold whose source_ref is exactly `sourceRef`. */
export interface ReconDiffHoldRelease {
  releaseBySource(
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly sourceRef: string; readonly releasedBy: string },
  ): Promise<{ readonly released: number }>;
}

export interface CloseAdminReconDiffDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  /** admin's audit writer bound to the closing transaction (the single writer of audit_logs). */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  readonly holds: ReconDiffHoldRelease;
}

/** The guard's verified admin account and the request's address (for the audit row). */
export interface ReconDiffCloseOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface ReconDiffCloseRequest {
  readonly body: Schema<'AdminReconDiffCloseRequest'>;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

/** Closes one R1–R3 recon diff of the operator's app; the response bytes (first result on replay). */
export function closeAdminReconDiff(
  deps: CloseAdminReconDiffDeps,
  operator: ReconDiffCloseOperator,
  reconDiffId: string,
  request: ReconDiffCloseRequest,
): Promise<IdempotentResponse> {
  void deps;
  void operator;
  void reconDiffId;
  void request;
  throw new Error('NotImplemented: closeAdminReconDiff');
}
