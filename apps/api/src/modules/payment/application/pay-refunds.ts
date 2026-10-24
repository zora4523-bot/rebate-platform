// B2-15e: the console's original-route refund (contract createAdminPayRefund /
// createAdminPayAnomalyRefund; 08 BR-PAY-06 ① ② ③ ⑤, 细则; 规划/04 §5「幂等」a:<admin_user_id>,
// D10-168 ②; D10-350 note; D10-351 ② ③). The controller (http/admin/) only authorises through the
// AdminOperationGuard (permission point pay.refund, no step-up: owner decision 2026-10-05), takes
// the parameters and calls createPayRefund; everything below runs here.
//
// createPayRefund, in order:
//   platform idempotency in its transactional mode (subject a:<admin_users.id>, the concrete path
//   of the operation, the Idempotency-Key header): a missing or malformed key is 20001 before
//   anything is read; a completed record of the same body replays the first answer byte for byte
//   (no handler, no channel call, no second audit row); another body under the same key is 20901;
//   the same key while the first request runs is 40901. The handler runs on the claim's
//   transaction, so the idempotency record, the refund row, the amount it holds, its first
//   refund.query job and the audit row commit together or not at all (BR-PAY-06 ②; D10-351 ③):
//     the channel adapter is resolved first (a process without it fails closed, nothing written);
//     the target is read, its business object lock taken (the pay order's biz object; an anomaly
//     receipt is its own object) and the target re-read: an unknown or foreign pay order /
//     anomaly → 20001 data.fields=[pay_order_id | pay_anomaly_id]; a pay order not PAID → 20902
//     resource pay_order (BR-PAY-06 ①);
//     the amount: Σ of the target's SUCCESS and PROCESSING refunds plus this one must not exceed
//     the refundable amount (the pay order's amount_fen, the anomaly's received amount_fen),
//     else 20001 data.fields=[amount_fen] (BR-PAY-06 ③; a FAILED refund holds nothing);
//     INSERT pay_refunds (RF1: PROCESSING; out_refund_no generated here, never changed; note as
//     given, D10-350), the first refund.query slot enqueued on the same transaction (queue pay,
//     singletonKey refund.query:<id>:t<seconds>, delayed), the audit row (action pay_refund_create,
//     admin's writer bound to this transaction);
//     the answer: the refund as created (contract AdminPayRefund), stored with the key.
//   Codes 2xxxx are not stored, so a refused key may be sent again; a failure of the record write
//   rolls everything back (5xx) and the key has no record afterwards.
//   Only after that commit, and only when this very call created the refund (not on a replay),
//   the channel is asked for the refund (外部写先落单, payment/AGENTS.md rule 7): ok / unknown /
//   a throwing adapter all leave the refund PROCESSING — the result comes from a verified
//   notification or from refund.query only, never from the submission's answer, and the same
//   out_refund_no is never submitted twice; one pay_query_attempts row (kind refund) keeps the
//   call. The response to the console is the stored one either way.
// Amounts stay bigint fen (@couli/money); nothing of a channel-side user exists here; no ledger
// posting happens at creation (BR-PAY-07 books on SUCCESS only).
import type { DB } from '@couli/db';
import type { Schema } from '@couli/contracts-ts';
import { addFen, fenToJsonNumber, parseFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import {
  fieldsErrorEnvelope,
  newUuidV7,
  type AuditPort,
  type Clock,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
  type JobQueue,
  type RootLogger,
} from '../../platform/index.ts';
import {
  generateOutRefundNo,
  nextRefundQueryInstant,
  refundQuerySlotSeconds,
} from '../domain/out-refund-no.ts';
import { delaySecondsUntil } from '../domain/pay-result.ts';
import type {
  PayChannelCode,
  PayRefundReason,
  PayRefundStatus,
  PayRefundTargetType,
} from '../domain/types.ts';
import { findOrderById, lockBizObject } from '../infra/pay-order-store.ts';
import {
  findAnomalyById,
  heldRefundFen,
  insertRefund,
  insertRefundAttempt,
  lockAnomaly,
  type PayRefundRow,
} from '../infra/pay-refund-store.ts';
import {
  PAY_QUEUE,
  REFUND_QUERY_JOB,
  refundQueryKey,
  type RefundQueryPayload,
} from '../jobs/names.ts';
import type { PayChannelSet, PayRefundInput, PayRefundResult } from './pay-channel.ts';

export interface PayRefundDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly channels: Pick<PayChannelSet, 'of'>;
  readonly idempotency: Idempotency;
  /** admin's audit writer bound to the creating transaction (the single writer of audit_logs). */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  readonly logger: RootLogger;
}

/** The refund's target, from the route (BR-PAY-06 ①). */
export type PayRefundTarget =
  | { readonly type: 'pay_order'; readonly id: string }
  | { readonly type: 'pay_anomaly'; readonly id: string };

/** The operator: the guard's verified admin account and the request's address (for the audit row). */
export interface PayRefundOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface PayRefundRequest {
  readonly body: Schema<'AdminPayRefundCreateRequest'>;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

/** The audit action of the contract (createAdminPayRefund / createAdminPayAnomalyRefund). */
export const PAY_REFUND_AUDIT_ACTION = 'pay_refund_create';

/** The concrete request path of a target (the idempotency scope; the contract's path templates). */
export function refundPathOf(target: PayRefundTarget): string {
  return target.type === 'pay_order'
    ? `/admin/v1/pay-orders/${target.id}/refunds`
    : `/admin/v1/pay-anomalies/${target.id}/refunds`;
}

/** The contract AdminPayRefund of a row: instants as ISO strings, fen as JSON integers. */
export function payRefundView(row: PayRefundRow): Schema<'AdminPayRefund'> {
  return {
    pay_refund_id: row.id,
    target_type: row.target_type as PayRefundTargetType,
    target_id: row.target_id,
    out_refund_no: row.out_refund_no,
    amount_fen: fenToJsonNumber(row.amount_fen),
    reason_code: row.reason_code as PayRefundReason,
    note: row.note,
    status: row.status as PayRefundStatus,
    channel_refund_no: row.channel_refund_no,
    operator: row.operator,
    created_at: row.created_at.toISOString(),
    succeeded_at: row.succeeded_at === null ? null : row.succeeded_at.toISOString(),
  };
}

/** BR-TEXT-14 fallback text of 20902 (contracts/texts.default.json error.20902). */
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';

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
      data: { resource: 'pay_order' },
      trace_id: traceId,
    },
  };
}

/** The original the refund goes back along, as re-read under the target's lock. */
interface Original {
  readonly payChannel: PayChannelCode;
  readonly outTradeNo: string | null;
  readonly channelTradeNo: string | null;
  /** The refundable amount: the pay order's amount_fen or the anomaly's received amount_fen. */
  readonly totalFen: bigint;
}

type TargetRead =
  | { readonly kind: 'refused'; readonly result: HandlerResult }
  | { readonly kind: 'found'; readonly original: Original };

/** The contract's Id is any short string; the id columns are uuid, so anything else is unknown. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Locks and re-reads the target (BR-PAY-06 ① ③ 先取业务对象级的锁，再校验). */
async function readTarget(
  trx: Transaction<DB>,
  appId: string,
  target: PayRefundTarget,
  traceId: string,
): Promise<TargetRead> {
  const field = target.type === 'pay_order' ? 'pay_order_id' : 'pay_anomaly_id';
  if (!UUID.test(target.id)) return { kind: 'refused', result: fieldsRefusal([field], traceId) };
  if (target.type === 'pay_order') {
    const seen = await findOrderById(trx, appId, target.id);
    if (seen === undefined)
      return { kind: 'refused', result: fieldsRefusal(['pay_order_id'], traceId) };
    await lockBizObject(trx, { appId, bizType: seen.biz_type, bizRef: seen.biz_ref });
    const order = await findOrderById(trx, appId, target.id);
    if (order === undefined)
      return { kind: 'refused', result: fieldsRefusal(['pay_order_id'], traceId) };
    if (order.status !== 'PAID') return { kind: 'refused', result: conflictRefusal(traceId) };
    return {
      kind: 'found',
      original: {
        payChannel: order.pay_channel as PayChannelCode,
        outTradeNo: order.out_trade_no,
        channelTradeNo: order.channel_trade_no,
        totalFen: order.amount_fen,
      },
    };
  }
  const seen = await findAnomalyById(trx, appId, target.id);
  if (seen === undefined)
    return { kind: 'refused', result: fieldsRefusal(['pay_anomaly_id'], traceId) };
  await lockAnomaly(trx, appId, target.id);
  const anomaly = await findAnomalyById(trx, appId, target.id);
  if (anomaly === undefined)
    return { kind: 'refused', result: fieldsRefusal(['pay_anomaly_id'], traceId) };
  return {
    kind: 'found',
    original: {
      payChannel: anomaly.pay_channel as PayChannelCode,
      outTradeNo: anomaly.out_trade_no,
      channelTradeNo: anomaly.channel_trade_no,
      totalFen: anomaly.amount_fen,
    },
  };
}

/** What the creating transaction leaves for the channel call after its commit. */
interface Created {
  readonly refund: PayRefundRow;
  readonly original: Original;
}

/**
 * POST /admin/v1/pay-orders/{pay_order_id}/refunds and POST
 * /admin/v1/pay-anomalies/{pay_anomaly_id}/refunds. Returns the idempotent response (status and the
 * exact body bytes) for the controller to send as is.
 */
export async function createPayRefund(
  deps: PayRefundDeps,
  operator: PayRefundOperator,
  target: PayRefundTarget,
  request: PayRefundRequest,
): Promise<IdempotentResponse> {
  const appId = operator.appId;
  const traceId = request.traceId;
  let created: Created | undefined;
  const response = await deps.idempotency.executeInTransaction(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: operator.adminId },
      method: 'POST',
      path: refundPathOf(target),
      key: request.key,
      body: request.body,
      traceId,
    },
    async (trx): Promise<HandlerResult> => {
      const key = request.key;
      if (key === undefined) throw new Error('payment: the idempotency key was validated before');
      const read = await readTarget(trx, appId, target, traceId);
      if (read.kind === 'refused') return read.result;
      const original = read.original;
      // The adapter of the target's channel: resolved before anything is written, so a process
      // without it fails closed without a refund row (payment/AGENTS.md rule 6).
      deps.channels.of(original.payChannel);
      const amountFen = parseFen(request.body.amount_fen);
      const held = await heldRefundFen(trx, appId, target.type, target.id);
      if (addFen(held, amountFen) > original.totalFen) {
        return fieldsRefusal(['amount_fen'], traceId);
      }
      const now = deps.clock.now();
      const refund = await insertRefund(trx, {
        id: newUuidV7(now),
        appId,
        targetType: target.type,
        targetId: target.id,
        idempotencyKey: key,
        outRefundNo: generateOutRefundNo(),
        amountFen,
        reasonCode: request.body.reason_code,
        note: request.body.note ?? null,
        operator: operator.adminId,
        now,
      });
      // D10-351 ③: the first active query is part of the creation, so a submission whose answer
      // never comes back is still queried (and never resubmitted).
      const first = nextRefundQueryInstant(refund.created_at, now);
      if (first !== null) {
        const payload: RefundQueryPayload = { app_id: appId, pay_refund_id: refund.id };
        await deps.queue.send(PAY_QUEUE, REFUND_QUERY_JOB, payload, {
          trx,
          singletonKey: refundQueryKey(refund.id, refundQuerySlotSeconds(refund.created_at, first)),
          delaySeconds: delaySecondsUntil(now, first),
        });
      }
      const view = payRefundView(refund);
      // BR-PAY-06: 写审计 (BR-ID-34); the operator, amount and reason code as the contract says.
      await deps.auditOn(trx).append({
        appId,
        actor: operator.adminId,
        action: PAY_REFUND_AUDIT_ACTION,
        target: `pay_refund:${refund.id}`,
        before: null,
        after: {
          pay_refund_id: view.pay_refund_id,
          target_type: view.target_type,
          target_id: view.target_id,
          out_refund_no: view.out_refund_no,
          amount_fen: view.amount_fen,
          reason_code: view.reason_code,
          note: view.note,
          status: view.status,
          operator: view.operator,
        },
        ip: operator.ip,
      });
      created = { refund, original };
      return { status: 200, envelope: { code: 0, msg: '', data: view, trace_id: traceId } };
    },
  );
  // Only this call's own creation submits (a replay, a refusal, a stored rejection never do).
  if (response.source === 'handler' && created !== undefined) {
    await submitRefund(deps, created);
  }
  return response;
}

/** The channel call after the commit (BR-PAY-06 ⑤ 结果未知时只查询; payment/AGENTS.md rule 7). */
async function submitRefund(deps: PayRefundDeps, created: Created): Promise<void> {
  const { refund, original } = created;
  const channel = original.payChannel;
  const input: PayRefundInput = {
    outTradeNo: original.outTradeNo,
    channelTradeNo: original.channelTradeNo,
    outRefundNo: refund.out_refund_no,
    refundFen: refund.amount_fen,
    totalFen: original.totalFen,
    reason: refund.reason_code,
  };
  const fields = {
    app_id: refund.app_id,
    pay_refund_id: refund.id,
    out_refund_no: refund.out_refund_no,
    pay_channel: channel,
    target_type: refund.target_type,
    target_id: refund.target_id,
  };
  deps.logger.info({ ...fields, amount_fen: refund.amount_fen.toString() }, 'pay_refund_created');
  let result: PayRefundResult;
  try {
    result = await deps.channels.of(channel).refund(input);
  } catch (error: unknown) {
    // A throwing adapter is an unknown answer: only the class is logged; refund.query decides.
    deps.logger.warn(
      { ...fields, error_class: error instanceof Error ? error.name : typeof error },
      'pay_refund_submit_threw',
    );
    result = { kind: 'unknown', reason: 'adapter_error' };
  }
  const now = deps.clock.now();
  await deps.db.transaction().execute((trx) =>
    insertRefundAttempt(trx, {
      id: newUuidV7(now),
      appId: refund.app_id,
      payRefundId: refund.id,
      kind: 'refund',
      request: {
        op: 'refund',
        pay_channel: channel,
        out_trade_no: input.outTradeNo,
        channel_trade_no: input.channelTradeNo,
        out_refund_no: input.outRefundNo,
        refund_fen: input.refundFen.toString(),
        total_fen: input.totalFen.toString(),
        reason: input.reason,
      },
      response: result.kind === 'ok' ? { kind: 'ok' } : { kind: 'unknown', reason: result.reason },
      result: result.kind === 'ok' ? 'accepted' : 'unknown',
      at: now,
    }),
  );
  if (result.kind === 'ok') {
    deps.logger.info(fields, 'pay_refund_submitted');
  } else {
    deps.logger.warn({ ...fields, reason: result.reason }, 'pay_refund_submit_unknown');
  }
}
