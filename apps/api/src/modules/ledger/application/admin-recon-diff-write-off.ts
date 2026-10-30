// B2-07e: POST /admin/v1/recon-diffs/{recon_diff_id}/write-off (contracts/openapi.yaml
// writeOffAdminReconDiff; 08 BR-WDR-23 ③ 决-08 A, BR-WDR-08 W11, BR-WDR-09, BR-FUND-19). The
// controller (http/admin/) only authorises through the AdminOperationGuard (payout.execute, step-up
// tier totp), takes the parameters and calls writeOffAdminReconDiff.
//
// writeOffAdminReconDiff runs under platform idempotency in its transactional mode (subject
// a:<admin_users.id>, the concrete path, the Idempotency-Key header); 2xxxx refusals are not
// stored. On the claim's transaction, in order:
//   the body (expected_withdrawal_status APPROVED; note, when given, 1–200 characters after
//   trimming, else 20001 [note]);
//   the app's R1–R3 recon_diffs row locked FOR UPDATE (unknown / another app / R4 / not a uuid →
//   20001 [recon_diff_id]); a status other than open / processing → 20902 recon_diff; not an R2
//   difference of case payer_side_returned with a withdrawal_id → 20001 [recon_diff_id] reason
//   not_payer_side_case;
//   W11 through the injected payout port (proveChannelSuccess on this transaction; a refusal →
//   20001 [recon_diff_id] with its reason; the withdrawal's conflict → 20902 withdrawal);
//   the row to written_off (handler_id the caller, closed_at = updated_at = the injected Clock,
//   resolution keeps its keys and adds w11 { withdrawal_id, paid_at, operator } and the trimmed
//   note);
//   every unreleased hold whose source_ref is exactly `recon_diff:<id>` released through the
//   injected payout port (released by admin:<id>);
//   the audit recon_diff_write_off (before / after statuses of the difference and the withdrawal,
//   withdrawal_id, released_hold_count; no personal data).
// Any failure rolls the whole write-off back (5xx) and leaves no idempotency record.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { AuditPort, Clock, Idempotency, IdempotentResponse } from '../../platform/index.ts';
import type { ReconDiffHoldRelease } from './admin-recon-diff-close.ts';

/** The guard conditions of W11 the payout port may refuse on (contract data.reason). */
export type ReconDiffWriteOffRefusal =
  | 'writeoff_disabled'
  | 'withdrawal_not_returned'
  | 'transfer_attempts_mismatch'
  | 'not_payer_side_case'
  | 'amount_mismatch';

/** The bill line stored with the difference (resolution.bill_line, else resolution.bill_row). */
export interface ReconDiffWriteOffBillLine {
  readonly billDate: string;
  readonly outBizNo: string | null;
  readonly channelOrderId: string | null;
  readonly bookedAt: string | null;
}

/** The payout port: W11 of the difference's withdrawal on the caller's transaction. */
export interface ReconDiffWriteOff {
  proveChannelSuccess(
    trx: Transaction<DB>,
    input: {
      readonly appId: string;
      readonly withdrawalId: string;
      readonly reconDiffId: string;
      readonly billLine: ReconDiffWriteOffBillLine;
      readonly expectedFen: bigint;
      readonly operatorId: string;
      readonly now: Date;
    },
  ): Promise<
    | {
        readonly kind: 'proven';
        readonly status: 'PAID_API';
        readonly paidAt: Date;
        readonly channelOrderId: string | null;
      }
    | { readonly kind: 'refused'; readonly reason: ReconDiffWriteOffRefusal }
  >;
}

export interface WriteOffAdminReconDiffDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  /** admin's audit writer bound to the write-off transaction (the single writer of audit_logs). */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  /** payout's release of the holds whose source is the difference. */
  readonly holds: ReconDiffHoldRelease;
  /** payout's W11 (the single writer of withdrawals). */
  readonly writeOff: ReconDiffWriteOff;
}

/** The guard's verified admin account and the request's address (for the audit row). */
export interface ReconDiffWriteOffOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface ReconDiffWriteOffRequest {
  readonly body: Schema<'AdminReconDiffWriteOffRequest'>;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

/** Writes off one R2 payer-side-returned difference of the operator's app by W11. */
export function writeOffAdminReconDiff(
  deps: WriteOffAdminReconDiffDeps,
  operator: ReconDiffWriteOffOperator,
  reconDiffId: string,
  request: ReconDiffWriteOffRequest,
): Promise<IdempotentResponse> {
  void deps;
  void operator;
  void reconDiffId;
  void request;
  throw new Error('NotImplemented: writeOffAdminReconDiff');
}
