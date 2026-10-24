// B2-15b: the queue and job names of the payment module (task §9.8 ～ §9.10). Only the names and
// payloads live here; the handlers (channel query, close) are B2-15c / B2-15d, registered by the
// worker entry then. Also compiled by the `test` project: erasable syntax only.
import type { JobPayload } from '../../platform/index.ts';
import type { PayJobName, PayQueueName } from '../domain/types.ts';

/** platform/queue/catalog.ts entry `pay` (exclusive: one queued or active job per singletonKey). */
export const PAY_QUEUE: PayQueueName = 'pay';

export const ORDER_QUERY_JOB: PayJobName = 'order.query';
export const ORDER_CLOSE_JOB: PayJobName = 'order.close';

/** Payload of `order.query`: which order to query and what triggered the query. */
export interface OrderQueryPayload extends JobPayload {
  readonly app_id: string;
  readonly pay_order_id: string;
  /** `returned`: the client came back from the channel SDK (BR-PAY-03 细则, one query). */
  readonly trigger: 'returned';
}

/** Payload of `order.close`: which order enters the close flow and why (BR-PAY-05). */
export interface OrderClosePayload extends JobPayload {
  readonly app_id: string;
  readonly pay_order_id: string;
  readonly close_reason: 'user_cancel';
}

/** singletonKey of the client-return query: one queued or active per order. */
export function orderQueryReturnedKey(payOrderId: string): string {
  return `${ORDER_QUERY_JOB}:${payOrderId}:returned`;
}

/** singletonKey of the close job: one queued or active per order. */
export function orderCloseKey(payOrderId: string): string {
  return `${ORDER_CLOSE_JOB}:${payOrderId}`;
}
