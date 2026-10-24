// B2-15d: the close flow of one pay order, the handler of job `order.close` (08 BR-PAY-05 ①～③,
// BR-PAY-02 PO2 / PO3, BR-PAY-03 取参数与关单在同一把业务对象锁内互斥; task §9.1 ～ §9.6).
// Rule-test stage: a NotImplemented skeleton; jobs/pay-jobs.ts routes `order.close` here once
// implemented. Also compiled by the `test` project: erasable syntax only.
import type { PayQueryDeps } from './pay-query.ts';

/** The close flow asks the channel, settles a paid answer (PO2) and enqueues its own next run. */
export type PayCloseDeps = PayQueryDeps;

/**
 * The handler of `order.close` (payload OrderClosePayload: app_id, pay_order_id, close_reason).
 * Under the business object lock on a fresh read: not PENDING, or needs_manual → nothing;
 * PENDING, not closing and past expire_at → closing, close_reason expired. Never placed and no
 * launch issued → PO3 at once; otherwise query first (paid → PO2, never closed), then the
 * channel's close, PO3 only on an explicit «closed»; «not exist» only after expire_at +
 * pay.close_grace_minutes and a query still not finding it. Still PENDING → the next run after
 * pay.close_retry_minutes; at expire_at + pay.close_wait_minutes → needs_manual, alert, stop.
 */
export function runOrderClose(deps: PayCloseDeps, payload: unknown): Promise<void> {
  void deps;
  void payload;
  throw new Error('NotImplemented: runOrderClose');
}
