// B2-15f: the manual settlement of a needs_manual pay order (contract resolveAdminPayOrder; 08
// BR-PAY-05 ③: needs_manual 由有处置权限的账号在后台【立即查询】后按渠道结果结束——
// 已支付 PO2；已关闭，或符合 ② 的不存在条件 PO3；操作需 step-up、写审计，凭证为查询响应;
// BR-PAY-04, BR-PAY-07). The
// controller (http/admin/) authorises through the AdminOperationGuard (pay.resolve, step-up tier
// totp from specs/permissions.yaml) and calls resolvePayOrder; everything below runs here.
//
// resolvePayOrder, in order:
//   ① the order by (app_id, pay_order_id): a non-UUID, unknown or foreign id → 20001
//      data.fields=[pay_order_id]; not PENDING or needs_manual false → 20902 resource pay_order.
//      Nothing is asked, recorded or audited for these.
//   ② the channel query, outside any transaction, through B2-15d's recordedQuery (trigger
//      admin_resolve): one pay_query_attempts row of kind query, committed on its own before any
//      judgement — the recorded response is the settlement's evidence (BR-PAY-05 ③ 凭证为查询响应).
//      A throwing adapter is an unknown answer (payment/AGENTS.md rule 7). The channel's close is
//      never called here.
//   ③ one transaction: the business object lock, the order re-read (no longer PENDING or no longer
//      needs_manual → 20902, nothing written: a notification, a query or another resolve won), then
//      by the answer (domain/pay-resolve.ts):
//        paid      → the checks of BR-PAY-04 (B2-15c's paidAnswerFacts and judgePayResult: identity
//                    ours, amount equal, state in pay.<pay_channel>.success_states) and B2-15c's
//                    settlePendingOrder: PO2 by transition() + CAS with the PAY_RECEIPT voucher
//                    (uniq PAY_RECEIPT:<pay_order_id>), biz.reconcile and pay_order.paid on this
//                    transaction; a failed check moves nothing;
//        closed    → PO3 (B2-15d's closeOrder: transition() + CAS);
//        not_exist → PO3 only on a query at or after expire_at + pay.close_grace_minutes
//                    (BR-PAY-05 ②, B2-15d's notExistMayClose), else nothing moves;
//        not paid / unknown → nothing moves, the order stays PENDING with needs_manual.
//      The audit row (action pay_order_resolve: the status before and after, the query result and
//      the attempt it is kept with) is appended on the same transaction, the unchanged outcome
//      included, so the settlement and its record commit together.
// No ledger posting other than settlePendingOrder's; no user account is touched. Log lines carry
// ids and states only, never a channel-side payer identifier or a channel original.
import type { DB } from '@couli/db';
import type { Schema } from '@couli/contracts-ts';
import type { Transaction } from 'kysely';
import type { AuditPort } from '../../platform/index.ts';
import { notExistMayClose } from '../domain/close-schedule.ts';
import { judgePayResult } from '../domain/pay-result.ts';
import { channelResultOf, resolvePlanOf, type ResolveQueryAnswer } from '../domain/pay-resolve.ts';
import type { PayChannelCode, PayOrderStatus } from '../domain/types.ts';
import { findOrderById, lockBizObject, type PayOrderRow } from '../infra/pay-order-store.ts';
import { adminPayOrderView, isUuid } from './pay-admin-reads.ts';
import type { PayChannel, PayQueryResult } from './pay-channel.ts';
import { closeOrder, closeSettingsOf, recordedQuery } from './pay-close.ts';
import { paidAnswerFacts, type PayQueryDeps } from './pay-query.ts';
import { PaySettlementConflict, settlePendingOrder, successStatesFor } from './pay-settlement.ts';

export interface PayResolveDeps extends PayQueryDeps {
  /** admin's audit writer bound to the settling transaction (the single writer of audit_logs). */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
}

/** The operator: the guard's verified admin account and the request's address (audit row). */
export interface PayResolveOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

/** The audit action of the contract (resolveAdminPayOrder). */
export const PAY_RESOLVE_AUDIT_ACTION = 'pay_order_resolve';

export type PayResolveOutcome =
  | { readonly kind: 'resolved'; readonly result: Schema<'AdminPayOrderResolveResult'> }
  | { readonly kind: 'fields'; readonly fields: readonly string[] }
  | { readonly kind: 'conflict' };

const CONFLICT: PayResolveOutcome = { kind: 'conflict' };

/** Only a PENDING order the close flow handed over (needs_manual) may be settled here. */
function resolvable(order: PayOrderRow): boolean {
  return order.status === 'PENDING' && order.needs_manual;
}

/** The answer as the settlement reads it: no amount, no identity, nothing of a payer. */
function answerOf(result: PayQueryResult): ResolveQueryAnswer {
  if (result.kind === 'unknown') return { kind: 'unknown' };
  return {
    kind: 'ok',
    state: result.state,
    channelState: result.channelState ?? null,
    channelTradeNo: result.channelTradeNo,
  };
}

/**
 * The paid answer under the lock on the fresh PENDING order: BR-PAY-04's checks, then PO2. Returns
 * the PAID order, or null when a check failed (nothing moves).
 */
async function settlePaid(
  deps: PayResolveDeps,
  trx: Transaction<DB>,
  adapter: PayChannel,
  fresh: PayOrderRow,
  result: Extract<PayQueryResult, { kind: 'ok' }>,
): Promise<PayOrderRow | null> {
  const channel = fresh.pay_channel as PayChannelCode;
  const base = { app_id: fresh.app_id, pay_order_id: fresh.id, pay_channel: channel };
  const facts = paidAnswerFacts(adapter, fresh.app_id, result);
  if (facts === null) {
    // Fail closed: a paid answer without the facts to check is not a payment.
    deps.logger.warn({ ...base, reason: 'incomplete' }, 'pay_resolve_mismatch');
    return null;
  }
  const verdict = judgePayResult({
    ours: facts.ours,
    order: { status: fresh.status as PayOrderStatus, amountFen: fresh.amount_fen },
    amountFen: facts.amountFen,
    channelState: facts.channelState,
    successStates: await successStatesFor(deps, fresh.app_id, channel),
  });
  if (verdict.kind === 'settle') {
    return settlePendingOrder(deps, trx, fresh, {
      channelTradeNo: facts.channelTradeNo,
      source: 'query',
    });
  }
  // rejected / mismatch (already_paid and anomaly cannot occur on a PENDING order).
  deps.logger.warn(
    { ...base, reason: verdict.kind === 'mismatch' ? verdict.reason : verdict.kind },
    'pay_resolve_mismatch',
  );
  return null;
}

/**
 * POST /admin/v1/pay-orders/{pay_order_id}/resolve, body fixed by the route schema
 * (expected_status PENDING, action query_and_settle).
 */
export async function resolvePayOrder(
  deps: PayResolveDeps,
  operator: PayResolveOperator,
  payOrderId: string,
): Promise<PayResolveOutcome> {
  const appId = operator.appId;
  if (!isUuid(payOrderId)) return { kind: 'fields', fields: ['pay_order_id'] };
  const id = payOrderId.toLowerCase();
  const seen = await findOrderById(deps.db, appId, id);
  if (seen === undefined) return { kind: 'fields', fields: ['pay_order_id'] };
  if (!resolvable(seen)) return CONFLICT;
  // The adapter of the order's channel: a process without it fails closed before any query.
  const adapter = deps.channels.of(seen.pay_channel as PayChannelCode);
  const settings = await closeSettingsOf(deps, appId);
  const queried = await recordedQuery(deps, adapter, seen, 'admin_resolve');
  const queriedAt = deps.clock.now();
  const answer = answerOf(queried.result);
  const plan = resolvePlanOf(answer, notExistMayClose(queriedAt, seen.expire_at, settings));
  const base = { app_id: appId, pay_order_id: id, pay_channel: seen.pay_channel };
  try {
    return await deps.db.transaction().execute(async (trx): Promise<PayResolveOutcome> => {
      await lockBizObject(trx, { appId, bizType: seen.biz_type, bizRef: seen.biz_ref });
      const fresh = await findOrderById(trx, appId, id);
      if (fresh === undefined || !resolvable(fresh)) return CONFLICT;
      let after: PayOrderRow = fresh;
      let settled = false;
      if (plan.kind === 'judge_paid' && queried.result.kind === 'ok') {
        const paid = await settlePaid(deps, trx, adapter, fresh, queried.result);
        if (paid !== null) {
          after = paid;
          settled = true;
        }
      } else if (plan.kind === 'close') {
        if (!(await closeOrder(deps, trx, fresh, plan.basis))) return CONFLICT;
        const closed = await findOrderById(trx, appId, id);
        if (closed === undefined) throw new Error('payment: the closed order vanished');
        after = closed;
      }
      const summary = channelResultOf(answer, settled);
      const channelResult: Schema<'AdminPayChannelResult'> = {
        state: summary.state,
        channel_state: summary.channelState,
        channel_trade_no: summary.channelTradeNo,
        queried_at: queriedAt.toISOString(),
      };
      // BR-PAY-05 ③ 写审计 (BR-ID-34): before / after status, the query result and its evidence.
      await deps.auditOn(trx).append({
        appId,
        actor: operator.adminId,
        action: PAY_RESOLVE_AUDIT_ACTION,
        target: `pay_order:${id}`,
        before: { pay_order_id: id, status: fresh.status, needs_manual: fresh.needs_manual },
        after: {
          pay_order_id: id,
          status: after.status,
          needs_manual: after.needs_manual,
          query_result: queried.result.kind === 'ok' ? queried.result.state : 'unknown',
          channel_result: channelResult,
          evidence: `pay_query_attempt:${queried.attemptId}`,
        },
        ip: operator.ip,
      });
      deps.logger.info(
        { ...base, status_before: fresh.status, status_after: after.status, state: summary.state },
        'pay_order_resolved',
      );
      return {
        kind: 'resolved',
        result: { pay_order: adminPayOrderView(after), channel_result: channelResult },
      };
    });
  } catch (error: unknown) {
    // PO2's CAS changed no row although the order was re-read PENDING under the lock: another
    // judgement moved it first; everything of this call rolled back.
    if (error instanceof PaySettlementConflict) {
      deps.logger.warn(base, 'pay_resolve_conflict');
      return CONFLICT;
    }
    throw error;
  }
}
