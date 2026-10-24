// B2-15c: the pure part of the pay result judgement (08 BR-PAY-04 and 细则, BR-PAY-05 ④; task
// §9.3 / §9.5 / §9.6). Skeleton of the rule-test phase: every function throws NotImplemented.
// No clock, no database: instants and configuration values come in as arguments.
// Also compiled by the `test` project: erasable syntax only.
import type { PayChannelCode, PayOrderStatus } from './types.ts';

/** Our pay order of the reported out_trade_no (same app, same channel), as the judgement needs it. */
export interface PayResultOrder {
  readonly status: PayOrderStatus;
  readonly amountFen: bigint;
}

/**
 * What a verified notification or a query answer says, next to our facts. The checks run in the
 * fixed order of task §9.3: ① identity ours → ② order found → ③ amount equal → ④ state listed.
 */
export interface PayResultFacts {
  /** ① the merchant / application identity resolves to this app (PayChannel.ownerAppOf). */
  readonly ours: boolean;
  /** ② our order of that out_trade_no on that channel in that app; null when there is none. */
  readonly order: PayResultOrder | null;
  /** The channel's order total in fen. */
  readonly amountFen: bigint;
  /** The channel's own trade state (exact, case-sensitive). */
  readonly channelState: string;
  /** `pay.<pay_channel>.success_states` in effect (successStatesOf). */
  readonly successStates: readonly string[];
}

export type PayMismatchReason = 'order_not_found' | 'amount_mismatch' | 'state_not_success';

/**
 * rejected: ① failed (no trace at all). mismatch: kept, alerted, nothing moves. settle: PENDING →
 * PO2 with the receipt posting and the fulfilment job. already_paid: nothing more. anomaly: money
 * received for a CLOSED order (orderFound true) or for an out_trade_no we have no order of
 * (orderFound false, the state being a listed success state): an anomaly receipt (BR-PAY-05 ④).
 */
export type PayResultVerdict =
  | { readonly kind: 'rejected' }
  | { readonly kind: 'mismatch'; readonly reason: PayMismatchReason }
  | { readonly kind: 'settle' }
  | { readonly kind: 'already_paid' }
  | { readonly kind: 'anomaly'; readonly orderFound: boolean };

export function judgePayResult(facts: PayResultFacts): PayResultVerdict {
  void facts;
  throw new Error('NotImplemented: judgePayResult');
}

/**
 * `pay.<pay_channel>.success_states` (BR-PAY-04 细则): absent (null / undefined) → the documented
 * success state only (wechat_pay SUCCESS, alipay TRADE_SUCCESS), fallback false; a non-empty array
 * of non-empty strings → as configured; anything else → the default with fallback true (alerted).
 */
export function successStatesOf(
  channel: PayChannelCode,
  raw: unknown,
): { readonly states: readonly string[]; readonly fallback: boolean } {
  void channel;
  void raw;
  throw new Error('NotImplemented: successStatesOf');
}

/**
 * `pay.query_schedule` in seconds after the order's creation (BR-PAY-04): absent → 10, 30, 60,
 * 180, 600 with fallback false; a non-empty, strictly increasing array of positive integers → as
 * configured; anything else → the default with fallback true (alerted).
 */
export function queryScheduleOf(raw: unknown): {
  readonly seconds: readonly number[];
  readonly fallback: boolean;
} {
  void raw;
  throw new Error('NotImplemented: queryScheduleOf');
}

/**
 * The planned query instants of one order: createdAt + each scheduled second that falls before
 * expireAt, then expireAt itself once (BR-PAY-04 「到 expire_at 再一次」), ascending.
 */
export function queryInstants(
  createdAt: Date,
  expireAt: Date,
  seconds: readonly number[],
): readonly Date[] {
  void createdAt;
  void expireAt;
  void seconds;
  throw new Error('NotImplemented: queryInstants');
}
