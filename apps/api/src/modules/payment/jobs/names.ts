// B2-15b / B2-15c: the queue and job names of the payment module (task B2-15b §9.8 ～ §9.10,
// B2-15c §9.4 ～ §9.7; D-PAY-11). Only the names, payloads and singleton keys live here; the
// handlers are in ./pay-jobs.ts (order.query, biz.reconcile) and B2-15d (order.close), registered
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

/** singletonKey of the fulfilment job: one queued or active per business object (serial per object). */
export function bizReconcileKey(bizType: string, bizRef: string): string {
  return `biz:${bizType}:${bizRef}`;
}
