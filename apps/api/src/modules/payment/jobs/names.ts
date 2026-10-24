// B2-15b / B2-15c: the queue and job names of the payment module (task B2-15b §9.8 ～ §9.10,
// B2-15c §9.4 ～ §9.7; D-PAY-11). Only the names, payloads and singleton keys live here; the
// handlers are in ./pay-jobs.ts (order.query, biz.reconcile, and order.close through
// application/pay-close.ts, B2-15d), registered
// by the worker entry. Also compiled by the `test` project: erasable syntax only.
import type { JobPayload } from '../../platform/index.ts';
import type { PayJobName, PayQueueName } from '../domain/types.ts';

/** platform/queue/catalog.ts entry `pay` (exclusive: one queued or active job per singletonKey). */
export const PAY_QUEUE: PayQueueName = 'pay';

export const ORDER_QUERY_JOB: PayJobName = 'order.query';
export const ORDER_CLOSE_JOB: PayJobName = 'order.close';
export const BIZ_RECONCILE_JOB: PayJobName = 'biz.reconcile';

/** The client came back from the channel SDK (BR-PAY-03 细则, one query; B2-15b). */
export interface OrderQueryReturnedPayload extends JobPayload {
  readonly app_id: string;
  readonly pay_order_id: string;
  readonly trigger: 'returned';
}

/**
 * A slot of `pay.query_schedule` (BR-PAY-04; B2-15c). The order is named by its out_trade_no, not
 * its id: pgboss rows are inspected by the text of their data, and a scheduled query must not be
 * mistaken for a job a user action enqueued (B2-15b's cancel leaves order.close as the only job
 * naming the order). The handler reads the order by (app_id, out_trade_no), unique in pay_orders.
 */
export interface OrderQueryScheduledPayload extends JobPayload {
  readonly app_id: string;
  readonly out_trade_no: string;
  readonly trigger: 'scheduled';
}

/** Payload of `order.query`: which order to query and what triggered the query. */
export type OrderQueryPayload = OrderQueryReturnedPayload | OrderQueryScheduledPayload;

/** Payload of `order.close`: which order enters the close flow and why (BR-PAY-05). */
export interface OrderClosePayload extends JobPayload {
  readonly app_id: string;
  readonly pay_order_id: string;
  /** user_cancel: POST …/cancel (B2-15b); expired: the expire_at query found it unpaid (B2-15c). */
  readonly close_reason: 'user_cancel' | 'expired';
}

/** Payload of `biz.reconcile`: the business object whose entitlement is recomputed (D10-168). */
export interface BizReconcilePayload extends JobPayload {
  readonly app_id: string;
  readonly biz_type: string;
  readonly biz_ref: string;
  /** The order whose settlement enqueued the job (tracing only; the facts are re-read). */
  readonly pay_order_id: string;
}

/**
 * B2-15e: payload of `refund.query` — the refund to query, by id (BR-PAY-06 ④ ⑤). Enqueued with a
 * delay in the same transaction that creates the refund (with its idempotency record and the
 * amount it holds), before the channel is called; the refund is submitted only after that commit
 * (D10-351 ③), so a refund whose submission never answered is still queried. The handler queries
 * the channel with the refund's own out_refund_no, keeps a pay_query_attempts row (kind
 * refund_query) and hands the answer to the same result handler as a refund notification. It never
 * submits the refund again (结果未知时只查询; resubmitting the same number waits for BR-PAY-09).
 */
export interface RefundQueryPayload extends JobPayload {
  readonly app_id: string;
  readonly pay_refund_id: string;
}

/** singletonKey of the client-return query: one queued or active per order. */
export function orderQueryReturnedKey(payOrderId: string): string {
  return `${ORDER_QUERY_JOB}:${payOrderId}:returned`;
}

/** singletonKey of one scheduled slot: whole seconds after the order's creation. */
export function orderQueryScheduledKey(payOrderId: string, slotSeconds: number): string {
  return `${ORDER_QUERY_JOB}:${payOrderId}:t${slotSeconds}`;
}

/** singletonKey of the close job: one queued or active per order. */
export function orderCloseKey(payOrderId: string): string {
  return `${ORDER_CLOSE_JOB}:${payOrderId}`;
}

/**
 * singletonKey of a close run the close flow enqueues for itself (B2-15d, task §9.3): the run's
 * instant in whole epoch seconds. It differs from orderCloseKey, so the next run is accepted while
 * the current one is still active (queue pay is exclusive per key); and every chain of one order
 * computes the same instants, so a cancel chain and an expiry chain merge into one.
 */
export function orderCloseRunKey(payOrderId: string, runAt: Date): string {
  return `${ORDER_CLOSE_JOB}:${payOrderId}:at${Math.ceil(runAt.getTime() / 1000)}`;
}

/** singletonKey of the fulfilment job: one queued or active per business object (serial per object). */
export function bizReconcileKey(bizType: string, bizRef: string): string {
  return `biz:${bizType}:${bizRef}`;
}
