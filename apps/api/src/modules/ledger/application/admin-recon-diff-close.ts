// B2-09b: POST /admin/v1/recon-diffs/{recon_diff_id}/close (contracts/openapi.yaml
// closeAdminReconDiff; 08 BR-FUND-19 差错单关闭时解除冻结记录, BR-FUND-22 「已关闭（不处理）」,
// BR-WDR-05 冻结记录逐条解除). The controller (http/admin/) only authorises through the
// AdminOperationGuard (fund.recon, no step-up), takes the parameters and calls closeAdminReconDiff.
//
// closeAdminReconDiff runs under platform idempotency in its transactional mode (subject
// a:<admin_users.id>, the concrete path, the Idempotency-Key header): a missing or malformed key is
// 20001 before anything is read; a completed record of the same body replays the first answer byte
// for byte (nothing released or audited again); another body → 20901; the same key while the first
// runs → 40901; 2xxxx refusals are not stored. On the claim's transaction, in order:
//   the reason, trimmed, 1–200 characters, else 20001 [reason];
//   the app's R1–R3 recon_diffs row locked FOR UPDATE (unknown / another app / R4 / not a uuid →
//   20001 [recon_diff_id], no 404); a status other than open / processing → 20902 resource
//   recon_diff; the compare-and-set to closed (handler_id the caller, closed_at = updated_at = the
//   injected Clock, resolution keeps its keys and records `reason`);
//   every unreleased hold whose source_ref is exactly `recon_diff:<id>` released through the
//   injected payout port (payout is the single writer of withdraw_holds; it locks the users rows
//   first, BR-WDR-07 — after the diff row here, as payout's recon job registers the diff before it
//   adds the holds);
//   the audit recon_diff_close (admin's writer bound to the transaction): the reason and, before and
//   after, status and released_hold_count; no personal data.
// Any failure rolls the whole close back (5xx) and leaves no idempotency record. Nothing is posted.
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
import { closeAdminReconDiffRow, lockAdminReconDiff } from '../infra/recon-diffs-store.ts';
import { UUID, detailView } from './admin-recon-diffs.ts';

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

/** The audit action of the contract (closeAdminReconDiff). */
export const RECON_DIFF_CLOSE_AUDIT_ACTION = 'recon_diff_close';

/** Contract AdminReconDiffCloseRequest.reason: 1–200 characters after trimming. */
const REASON_MAX = 200;

/** BR-TEXT-14 fallback text of 20902 (contracts/texts.default.json error.20902). */
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';

/** The source_ref of the holds a diff added (payout's recon job, B2-07c), matched exactly. */
export function reconDiffHoldSource(reconDiffId: string): string {
  return `recon_diff:${reconDiffId}`;
}

/** The concrete request path (the idempotency scope). */
function closePathOf(reconDiffId: string): string {
  return `/admin/v1/recon-diffs/${reconDiffId}/close`;
}

function fieldsRefusal(fields: readonly string[], traceId: string): HandlerResult {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return { status: refused.statusCode, envelope: refused.body };
}

function conflictRefusal(traceId: string): HandlerResult {
  return {
    status: 409,
    envelope: {
      code: 20902,
      msg: CONFLICT_MESSAGE,
      data: { resource: 'recon_diff' },
      trace_id: traceId,
    },
  };
}

/** The resolution after closing: the stored keys kept, `reason` set. */
function closedResolution(stored: unknown, reason: string): object {
  const base =
    typeof stored === 'object' && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  return { ...base, reason };
}

/** Closes one R1–R3 recon diff of the operator's app; the response bytes (first result on replay). */
export function closeAdminReconDiff(
  deps: CloseAdminReconDiffDeps,
  operator: ReconDiffCloseOperator,
  reconDiffId: string,
  request: ReconDiffCloseRequest,
): Promise<IdempotentResponse> {
  const { appId, adminId } = operator;
  const traceId = request.traceId;
  return deps.idempotency.executeInTransaction(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      path: closePathOf(reconDiffId),
      key: request.key,
      body: request.body,
      traceId,
    },
    async (trx): Promise<HandlerResult> => {
      const reason = request.body.reason.trim();
      const length = [...reason].length;
      if (length < 1 || length > REASON_MAX) return fieldsRefusal(['reason'], traceId);
      if (!UUID.test(reconDiffId)) return fieldsRefusal(['recon_diff_id'], traceId);
      const id = reconDiffId.toLowerCase();
      const row = await lockAdminReconDiff(trx, appId, id);
      if (row === undefined) return fieldsRefusal(['recon_diff_id'], traceId);
      if (row.status !== 'open' && row.status !== 'processing') return conflictRefusal(traceId);
      const closed = await closeAdminReconDiffRow(trx, {
        appId,
        id,
        handlerId: adminId,
        at: deps.clock.now(),
        resolution: closedResolution(row.resolution, reason),
      });
      // The row is locked above, so the compare-and-set cannot miss; refuse rather than go on.
      if (closed === undefined) return conflictRefusal(traceId);
      const { released } = await deps.holds.releaseBySource(trx, {
        appId,
        sourceRef: reconDiffHoldSource(id),
        releasedBy: adminId,
      });
      await deps.auditOn(trx).append({
        appId,
        actor: adminId,
        action: RECON_DIFF_CLOSE_AUDIT_ACTION,
        target: id,
        before: { status: row.status, released_hold_count: 0 },
        after: { status: closed.status, released_hold_count: released, reason },
        ip: operator.ip,
      });
      const data: Schema<'AdminReconDiffClose'> = {
        recon_diff: detailView(closed),
        released_hold_count: released,
      };
      return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
    },
  );
}
