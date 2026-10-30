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
import {
  fieldsErrorEnvelope,
  type AuditPort,
  type Clock,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
} from '../../platform/index.ts';
import { lockAdminReconDiff, writeOffAdminReconDiffRow } from '../infra/recon-diffs-store.ts';
import { reconDiffHoldSource, type ReconDiffHoldRelease } from './admin-recon-diff-close.ts';
import { UUID, detailView } from './admin-recon-diffs.ts';

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

/** The audit action of the contract (writeOffAdminReconDiff). */
export const RECON_DIFF_WRITE_OFF_AUDIT_ACTION = 'recon_diff_write_off';

/** Contract AdminReconDiffWriteOffRequest.note: 1–200 characters after trimming when given. */
const NOTE_MAX = 200;
/** BR-TEXT-14 fallback text of 20902 (contracts/texts.default.json error.20902). */
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';
/** The R2 case the reconciliation registers for a W9-returned withdrawal (payout's recon job). */
const PAYER_SIDE_CASE = 'payer_side_returned';

/** The concrete request path (the idempotency scope). */
function writeOffPathOf(reconDiffId: string): string {
  return `/admin/v1/recon-diffs/${reconDiffId}/write-off`;
}

function fieldsRefusal(fields: readonly string[], traceId: string): HandlerResult {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return { status: refused.statusCode, envelope: refused.body };
}

/** 20001 data.fields=[recon_diff_id] with the W11 guard's reason (contract). */
function guardRefusal(reason: ReconDiffWriteOffRefusal, traceId: string): HandlerResult {
  const refused = fieldsErrorEnvelope(['recon_diff_id'], traceId);
  const body = refused.body as { data?: Record<string, unknown> };
  return {
    status: refused.statusCode,
    envelope: { ...refused.body, data: { ...(body.data ?? {}), reason } },
  };
}

function conflictRefusal(resource: 'recon_diff' | 'withdrawal', traceId: string): HandlerResult {
  return {
    status: 409,
    envelope: { code: 20902, msg: CONFLICT_MESSAGE, data: { resource }, trace_id: traceId },
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The withdrawal's conflict thrown by payout's port (20902 data.resource=withdrawal). */
function isWithdrawalConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 20902 &&
    asObject((error as { data?: unknown }).data)?.['resource'] === 'withdrawal'
  );
}

/**
 * The proof of the difference: its withdrawal and the bill line the reconciliation stored
 * (resolution.bill_line, else the recon_channel row resolution.bill_row with the difference's own
 * out_biz_no). Null when the difference is not the R2 payer-side case.
 */
function proofOf(
  stored: Record<string, unknown> | null,
  period: string,
): { withdrawalId: string; billLine: ReconDiffWriteOffBillLine } | null {
  if (stored === null || stored['case'] !== PAYER_SIDE_CASE) return null;
  const withdrawalId = text(stored['withdrawal_id']);
  if (withdrawalId === null) return null;
  const billDate = text(stored['bill_date']) ?? period;
  const line = asObject(stored['bill_line']);
  if (line !== null) {
    return {
      withdrawalId,
      billLine: {
        billDate,
        outBizNo: text(line['out_biz_no']),
        channelOrderId: text(line['channel_order_id']),
        bookedAt: text(line['booked_at']),
      },
    };
  }
  const row = asObject(stored['bill_row']);
  if (row !== null) {
    return {
      withdrawalId,
      billLine: {
        billDate,
        outBizNo: text(stored['out_biz_no']),
        channelOrderId: text(row['channel_order_id']),
        bookedAt: text(row['booked_at']),
      },
    };
  }
  return null;
}

/** Writes off one R2 payer-side-returned difference of the operator's app by W11. */
export function writeOffAdminReconDiff(
  deps: WriteOffAdminReconDiffDeps,
  operator: ReconDiffWriteOffOperator,
  reconDiffId: string,
  request: ReconDiffWriteOffRequest,
): Promise<IdempotentResponse> {
  const { appId, adminId } = operator;
  const traceId = request.traceId;
  return deps.idempotency.executeInTransaction(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      path: writeOffPathOf(reconDiffId),
      key: request.key,
      body: request.body,
      traceId,
    },
    async (trx): Promise<HandlerResult> => {
      if (request.body.expected_withdrawal_status !== 'APPROVED') {
        return fieldsRefusal(['expected_withdrawal_status'], traceId);
      }
      let note: string | undefined;
      if (request.body.note !== undefined) {
        note = request.body.note.trim();
        const length = [...note].length;
        if (length < 1 || length > NOTE_MAX) return fieldsRefusal(['note'], traceId);
      }
      if (!UUID.test(reconDiffId)) return fieldsRefusal(['recon_diff_id'], traceId);
      const id = reconDiffId.toLowerCase();
      const row = await lockAdminReconDiff(trx, appId, id);
      if (row === undefined) return fieldsRefusal(['recon_diff_id'], traceId);
      if (row.status !== 'open' && row.status !== 'processing') {
        return conflictRefusal('recon_diff', traceId);
      }
      const stored = asObject(row.resolution);
      const proof = row.source === 'R2' ? proofOf(stored, row.period) : null;
      if (proof === null) return guardRefusal('not_payer_side_case', traceId);
      const now = deps.clock.now();
      let proven: Awaited<ReturnType<ReconDiffWriteOff['proveChannelSuccess']>>;
      try {
        proven = await deps.writeOff.proveChannelSuccess(trx, {
          appId,
          withdrawalId: proof.withdrawalId,
          reconDiffId: id,
          billLine: proof.billLine,
          expectedFen: row.actual_fen,
          operatorId: adminId,
          now,
        });
      } catch (error) {
        if (isWithdrawalConflict(error)) return conflictRefusal('withdrawal', traceId);
        throw error;
      }
      if (proven.kind === 'refused') return guardRefusal(proven.reason, traceId);
      const written = await writeOffAdminReconDiffRow(trx, {
        appId,
        id,
        handlerId: adminId,
        at: now,
        resolution: {
          ...(stored ?? {}),
          w11: {
            withdrawal_id: proof.withdrawalId,
            paid_at: proven.paidAt.toISOString(),
            operator: adminId,
          },
          ...(note === undefined ? {} : { note }),
        },
      });
      // The row is locked above, so the compare-and-set cannot miss; refuse rather than go on.
      if (written === undefined) return conflictRefusal('recon_diff', traceId);
      const { released } = await deps.holds.releaseBySource(trx, {
        appId,
        sourceRef: reconDiffHoldSource(id),
        releasedBy: `admin:${adminId}`,
      });
      await deps.auditOn(trx).append({
        appId,
        actor: adminId,
        action: RECON_DIFF_WRITE_OFF_AUDIT_ACTION,
        target: id,
        before: {
          status: row.status,
          withdrawal_id: proof.withdrawalId,
          withdrawal_status: 'APPROVED',
          released_hold_count: 0,
        },
        after: {
          status: written.status,
          withdrawal_id: proof.withdrawalId,
          withdrawal_status: proven.status,
          released_hold_count: released,
          ...(note === undefined ? {} : { note }),
        },
        ip: operator.ip,
      });
      const data: Schema<'AdminReconDiffWriteOff'> = {
        recon_diff: detailView(written),
        withdrawal: {
          withdrawal_id: proof.withdrawalId,
          status: proven.status,
          paid_at: proven.paidAt.toISOString(),
          channel_order_id: proven.channelOrderId,
        },
        released_hold_count: released,
      };
      return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
    },
  );
}
